//! Narrow Neon boundary for the Wcash Testnet receive wallet.
//!
//! This module deliberately does not reuse the Zingo `LightClient` global in
//! `lib.rs`. The database path, endpoint, network and key derivation contract
//! are fixed here and the master seed exists only for create/restore calls.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use bip0039::{Count, English, Mnemonic};
use neon::prelude::*;
use once_cell::sync::Lazy;
use secrecy::SecretVec;
use wcash_wallet::{
    derive_wallet_spending_key, encode_orchard_receiver, encode_transparent_coinbase_receiver,
    WalletNetwork,
};
use zeroize::Zeroizing;
use zingolib::wcash::{WalletSyncCancellation, WcashTestnet, WcashTestnetRuntime};

use super::{with_panic_guard, ZingolibError, RT, WALLET_BASE_DIR};

const WCASH_TESTNET_ENDPOINT: &str = "https://wallet-testnet.wcashexplorer.com:443";
const WCASH_WALLET_DATABASE: &str = "wallet.db";
const WCASH_SEED_SCHEME: &str = "bip39-english-24-empty-passphrase-v1";

static WCASH_RUNTIME: Lazy<Mutex<Option<WcashTestnetRuntime>>> = Lazy::new(|| Mutex::new(None));
static ACTIVE_SYNC: Lazy<Mutex<Option<WalletSyncCancellation>>> = Lazy::new(|| Mutex::new(None));

pub(super) fn export(cx: &mut ModuleContext) -> NeonResult<()> {
    cx.export_function("wcash_status", status)?;
    cx.export_function("wcash_generate_mnemonic", generate_mnemonic)?;
    cx.export_function("wcash_validate_mnemonic", validate_mnemonic)?;
    cx.export_function("wcash_verify_mnemonic", verify_mnemonic)?;
    cx.export_function("wcash_create", create)?;
    cx.export_function("wcash_restore", restore)?;
    cx.export_function("wcash_open", open)?;
    cx.export_function("wcash_sync", sync)?;
    cx.export_function("wcash_stop_sync", stop_sync)?;
    cx.export_function("wcash_balance", balance)?;
    cx.export_function("wcash_receivers", receivers)?;
    Ok(())
}

fn wallet_path() -> Result<PathBuf, ZingolibError> {
    let base = WALLET_BASE_DIR.get().ok_or_else(|| {
        ZingolibError::Init("Wcash wallet base directory is not configured".to_owned())
    })?;
    wallet_path_under(base)
}

fn wallet_path_under(base: &Path) -> Result<PathBuf, ZingolibError> {
    let wallet_directory = base.join(WcashTestnet.storage_namespace());
    fs::create_dir_all(&wallet_directory)
        .map_err(|error| ZingolibError::Init(format!("create Wcash wallet directory: {error}")))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(&wallet_directory, fs::Permissions::from_mode(0o700)).map_err(
            |error| ZingolibError::Init(format!("secure Wcash wallet directory: {error}")),
        )?;
    }

    Ok(wallet_directory.join(WCASH_WALLET_DATABASE))
}

fn store_runtime(runtime: WcashTestnetRuntime) -> Result<(), ZingolibError> {
    let mut slot = WCASH_RUNTIME
        .lock()
        .map_err(|_| ZingolibError::Init("Wcash runtime lock poisoned".to_owned()))?;
    *slot = Some(runtime);
    Ok(())
}

fn json_promise<'a, F>(mut cx: FunctionContext<'a>, work: F) -> JsResult<'a, JsPromise>
where
    F: FnOnce() -> Result<String, ZingolibError> + Send + 'static,
{
    let promise = cx.task(work).promise(|mut cx, result| match result {
        Ok(value) => Ok(cx.string(value)),
        Err(error) => cx.throw_error(error.to_string()),
    });
    Ok(promise)
}

fn mnemonic_master_seed(mnemonic: &Mnemonic<English>) -> SecretVec<u8> {
    // Preserve Zingo's established BIP39 recovery contract: the backend sees
    // the standard 64-byte BIP39 seed produced with an empty passphrase. The
    // Wcash domain KDF then binds those bytes to this chain and network.
    let bip39_seed = Zeroizing::new(mnemonic.to_seed(""));
    SecretVec::new(bip39_seed.as_slice().to_vec())
}

fn parse_mnemonic(seed_phrase: &str) -> Result<Mnemonic<English>, ZingolibError> {
    if seed_phrase.split_whitespace().count() != Count::Words24.word_count() {
        return Err(ZingolibError::Init(
            "Wcash recovery phrase must contain exactly 24 words".to_owned(),
        ));
    }
    let mnemonic = Mnemonic::<English>::from_phrase(seed_phrase)
        .map_err(|error| ZingolibError::Init(format!("invalid BIP39 recovery phrase: {error}")))?;
    Ok(mnemonic)
}

fn mnemonic_receivers(mnemonic: &Mnemonic<English>) -> Result<(String, String), ZingolibError> {
    let master_seed = mnemonic_master_seed(mnemonic);
    let ufvk = derive_wallet_spending_key(&master_seed, WalletNetwork::Testnet, 0)
        .map_err(|error| ZingolibError::Read(format!("derive Wcash account identity: {error}")))?
        .to_unified_full_viewing_key();
    let ironwood = encode_orchard_receiver(&ufvk, WalletNetwork::Testnet)
        .map_err(|error| ZingolibError::Read(format!("derive Wcash Ironwood receiver: {error}")))?;
    let transparent =
        encode_transparent_coinbase_receiver(&ufvk, WalletNetwork::Testnet).map_err(|error| {
            ZingolibError::Read(format!("derive Wcash transparent receiver: {error}"))
        })?;
    Ok((ironwood, transparent))
}

fn receiver_pair_matches(
    derived_ironwood: &str,
    derived_transparent: &str,
    stored_ironwood: &str,
    stored_transparent: &str,
) -> bool {
    derived_ironwood == stored_ironwood && derived_transparent == stored_transparent
}

fn generate_mnemonic(mut cx: FunctionContext) -> JsResult<JsString> {
    let mnemonic = Mnemonic::<English>::generate(Count::Words24);
    let phrase = Zeroizing::new(mnemonic.phrase().to_owned());
    Ok(cx.string(phrase.as_str()))
}

fn validate_mnemonic(mut cx: FunctionContext) -> JsResult<JsString> {
    let seed_phrase = Zeroizing::new(cx.argument::<JsString>(0)?.value(&mut cx));
    match parse_mnemonic(seed_phrase.as_str()) {
        Ok(mnemonic) => {
            let normalized = Zeroizing::new(mnemonic.phrase().to_owned());
            Ok(cx.string(normalized.as_str()))
        }
        Err(error) => cx.throw_error(error.to_string()),
    }
}

/// Proves that one main-process-only recovery phrase owns the account stored
/// in the fixed Wcash Testnet database. Only the boolean comparison result
/// crosses the Neon boundary; neither keys nor derived addresses are exposed.
fn verify_mnemonic(mut cx: FunctionContext) -> JsResult<JsBoolean> {
    let seed_phrase = Zeroizing::new(cx.argument::<JsString>(0)?.value(&mut cx));
    match with_panic_guard(|| {
        let mnemonic = parse_mnemonic(seed_phrase.as_str())?;
        let (ironwood, transparent) = mnemonic_receivers(&mnemonic)?;
        let wallet = WcashTestnetRuntime::inspect(wallet_path()?).map_err(|error| {
            ZingolibError::Read(format!("inspect Wcash Testnet wallet: {error}"))
        })?;
        Ok(receiver_pair_matches(
            &ironwood,
            &transparent,
            &wallet.address,
            &wallet.transparent_coinbase_address,
        ))
    }) {
        Ok(matches) => Ok(cx.boolean(matches)),
        Err(error) => cx.throw_error(error.to_string()),
    }
}

fn status(cx: FunctionContext) -> JsResult<JsPromise> {
    json_promise(cx, || {
        with_panic_guard(|| {
            let path = wallet_path()?;
            let wallet = if path.exists() {
                Some(WcashTestnetRuntime::inspect(&path).map_err(|error| {
                    ZingolibError::Read(format!("Wcash Testnet wallet: {error}"))
                })?)
            } else {
                None
            };
            Ok(serde_json::json!({
                "network": "Wcash Testnet",
                "ticker": WcashTestnet.ticker(),
                "storage_namespace": WcashTestnet.storage_namespace(),
                "wallet": wallet,
            })
            .to_string())
        })
    })
}

fn create(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let seed_phrase = Zeroizing::new(cx.argument::<JsString>(0)?.value(&mut cx));
    json_promise(cx, move || {
        with_panic_guard(|| {
            let mnemonic = parse_mnemonic(seed_phrase.as_str())?;
            let master_seed = mnemonic_master_seed(&mnemonic);
            let path = wallet_path()?;
            let (runtime, wallet) = RT
                .block_on(WcashTestnetRuntime::create(
                    WCASH_TESTNET_ENDPOINT,
                    &path,
                    &master_seed,
                ))
                .map_err(|error| ZingolibError::Init(format!("Wcash Testnet create: {error}")))?;
            store_runtime(runtime)?;
            Ok(serde_json::json!({
                "wallet": wallet,
                "seed_scheme": WCASH_SEED_SCHEME,
            })
            .to_string())
        })
    })
}

fn restore(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let seed_phrase = Zeroizing::new(cx.argument::<JsString>(0)?.value(&mut cx));
    let birthday = cx.argument::<JsNumber>(1)?.value(&mut cx);
    if !birthday.is_finite()
        || birthday.fract() != 0.0
        || birthday < 1.0
        || birthday > u32::MAX as f64
    {
        return cx.throw_range_error(
            "Wcash Testnet birthday must be an integer from 1 through 4294967295",
        );
    }
    let birthday = birthday as u32;

    json_promise(cx, move || {
        with_panic_guard(|| {
            let mnemonic = parse_mnemonic(seed_phrase.as_str())?;
            let master_seed = mnemonic_master_seed(&mnemonic);
            let path = wallet_path()?;
            let (runtime, wallet) = RT
                .block_on(WcashTestnetRuntime::restore(
                    WCASH_TESTNET_ENDPOINT,
                    &path,
                    &master_seed,
                    birthday,
                ))
                .map_err(|error| ZingolibError::Init(format!("Wcash Testnet restore: {error}")))?;
            store_runtime(runtime)?;
            Ok(serde_json::json!({
                "wallet": wallet,
                "seed_scheme": WCASH_SEED_SCHEME,
            })
            .to_string())
        })
    })
}

fn open(cx: FunctionContext) -> JsResult<JsPromise> {
    json_promise(cx, || {
        with_panic_guard(|| {
            let path = wallet_path()?;
            let (runtime, wallet) = RT
                .block_on(WcashTestnetRuntime::open(WCASH_TESTNET_ENDPOINT, &path))
                .map_err(|error| ZingolibError::Init(format!("Wcash Testnet open: {error}")))?;
            store_runtime(runtime)?;
            Ok(serde_json::json!({ "wallet": wallet }).to_string())
        })
    })
}

fn sync(cx: FunctionContext) -> JsResult<JsPromise> {
    json_promise(cx, || {
        with_panic_guard(|| {
            let cancellation = WalletSyncCancellation::new();
            {
                let mut active = ACTIVE_SYNC.lock().map_err(|_| {
                    ZingolibError::Sync("Wcash sync cancellation lock poisoned".to_owned())
                })?;
                if active.is_some() {
                    return Err(ZingolibError::Sync(
                        "Wcash sync is already running".to_owned(),
                    ));
                }
                *active = Some(cancellation.clone());
            }
            let _active_sync = ActiveSyncGuard;
            let mut slot = WCASH_RUNTIME
                .lock()
                .map_err(|_| ZingolibError::Sync("Wcash runtime lock poisoned".to_owned()))?;
            let runtime = slot
                .as_mut()
                .ok_or_else(|| ZingolibError::Sync("Wcash wallet is not open".to_owned()))?;
            let summary = RT
                .block_on(runtime.sync(&cancellation))
                .map_err(|error| ZingolibError::Sync(format!("Wcash Testnet sync: {error}")))?;
            serde_json::to_string(&summary)
                .map_err(|error| ZingolibError::Sync(format!("serialize Wcash balance: {error}")))
        })
    })
}

struct ActiveSyncGuard;

impl Drop for ActiveSyncGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_SYNC.lock() {
            *active = None;
        }
    }
}

fn stop_sync(mut cx: FunctionContext) -> JsResult<JsBoolean> {
    let stopped = ACTIVE_SYNC
        .lock()
        .ok()
        .and_then(|active| active.as_ref().cloned())
        .map(|cancellation| {
            cancellation.cancel();
            true
        })
        .unwrap_or(false);
    Ok(cx.boolean(stopped))
}

fn balance(cx: FunctionContext) -> JsResult<JsPromise> {
    json_promise(cx, || {
        with_panic_guard(|| {
            let slot = WCASH_RUNTIME
                .lock()
                .map_err(|_| ZingolibError::Read("Wcash runtime lock poisoned".to_owned()))?;
            let runtime = slot
                .as_ref()
                .ok_or_else(|| ZingolibError::Read("Wcash wallet is not open".to_owned()))?;
            let summary = runtime
                .balance()
                .map_err(|error| ZingolibError::Read(format!("Wcash Testnet balance: {error}")))?;
            serde_json::to_string(&summary)
                .map_err(|error| ZingolibError::Read(format!("serialize Wcash balance: {error}")))
        })
    })
}

fn receivers(cx: FunctionContext) -> JsResult<JsPromise> {
    json_promise(cx, || {
        with_panic_guard(|| {
            let slot = WCASH_RUNTIME
                .lock()
                .map_err(|_| ZingolibError::Read("Wcash runtime lock poisoned".to_owned()))?;
            let runtime = slot
                .as_ref()
                .ok_or_else(|| ZingolibError::Read("Wcash wallet is not open".to_owned()))?;
            let addresses = runtime.receive().map_err(|error| {
                ZingolibError::Read(format!("Wcash Testnet receivers: {error}"))
            })?;
            serde_json::to_string(&addresses)
                .map_err(|error| ZingolibError::Read(format!("serialize Wcash receivers: {error}")))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wallet_path_is_namespaced_under_the_product_data_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let path = wallet_path_under(temporary.path()).unwrap();

        assert_eq!(
            path,
            temporary
                .path()
                .join(WcashTestnet.storage_namespace())
                .join(WCASH_WALLET_DATABASE)
        );
    }

    #[test]
    fn mnemonic_contract_is_stable_and_derives_a_wcash_address_vector() {
        use secrecy::ExposeSecret;

        const ZERO_ENTROPY_PHRASE: &str =
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
        let mnemonic = parse_mnemonic(ZERO_ENTROPY_PHRASE).unwrap();
        let seed = mnemonic_master_seed(&mnemonic);
        let (ironwood, transparent) = mnemonic_receivers(&mnemonic).unwrap();

        assert_eq!(seed.expose_secret().len(), 64);
        assert_eq!(WCASH_SEED_SCHEME, "bip39-english-24-empty-passphrase-v1");
        assert_eq!(
            ironwood,
            "wutest18rmpm4xcm2d54xg5mg00lac9pg4txaladyp6pacqhm355n5scpn5gja6hy43uqassvr63g6xuephu8r0qju92778lg4v5nkxfu7j3la6"
        );
        assert_eq!(transparent, "WTMMWgVvepdG58zdNjePbtyoh4aSwb4kP3E");
    }

    #[test]
    fn mnemonic_identity_comparison_requires_both_fixed_testnet_receivers() {
        const ZERO_ENTROPY_PHRASE: &str =
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
        let mnemonic = parse_mnemonic(ZERO_ENTROPY_PHRASE).unwrap();
        let (ironwood, transparent) = mnemonic_receivers(&mnemonic).unwrap();

        assert!(receiver_pair_matches(
            &ironwood,
            &transparent,
            &ironwood,
            &transparent
        ));
        assert!(!receiver_pair_matches(
            &ironwood,
            &transparent,
            "wutest1wrong",
            &transparent
        ));
        assert!(!receiver_pair_matches(
            &ironwood,
            &transparent,
            &ironwood,
            "WTWrong"
        ));
    }
}
