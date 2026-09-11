//! Narrow Neon boundary for the Wcash Testnet wallet.
//!
//! This module deliberately does not reuse the Zingo `LightClient` global in
//! `lib.rs`. The database path, endpoint, network and key derivation contract
//! are fixed here. Spending authority is supplied only to explicit create,
//! restore, send, and coinbase-shielding calls and never crosses back to JS.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use bip0039::{Count, English, Mnemonic};
use neon::prelude::*;
use once_cell::sync::Lazy;
use secrecy::SecretVec;
use serde_json::{Map, Value};
use wcash_wallet::{
    decode_recipient, derive_wallet_spending_key, encode_orchard_receiver,
    encode_transparent_coinbase_receiver, WalletNetwork, MAX_PENDING_TRANSACTION_PAGE_SIZE,
    MAX_TRANSFER_RECIPIENTS,
};
use zeroize::Zeroizing;
use zingolib::wcash::{
    BroadcastResult, SignedTransaction, StoredSignedTransaction, WalletSyncCancellation,
    WcashTestnet, WcashTestnetPayment, WcashTestnetRuntime,
};

use super::{with_panic_guard, ZingolibError, RT, WALLET_BASE_DIR};

const WCASH_TESTNET_ENDPOINT: &str = "https://wallet-testnet.wcashexplorer.com:443";
const WCASH_WALLET_DATABASE: &str = "wallet.db";
const WCASH_SEED_SCHEME: &str = "bip39-english-24-empty-passphrase-v1";
const TRANSACTION_SCHEMA_VERSION: u8 = 1;
const ZATOSHIS_PER_WEC: u64 = 100_000_000;
const WCASH_MAX_SUPPLY_ZAT: u64 = 21_000_000 * ZATOSHIS_PER_WEC;
const MAX_SEND_REQUEST_BYTES: usize = 128 * 1024;
const MAX_RECIPIENT_ADDRESS_BYTES: usize = 1_024;
const MAX_MEMO_BYTES: usize = 512;
const RECOVERY_REQUIRED_CODE: &str = "exact_transaction_rebroadcast_required";

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
    cx.export_function("wcash_validate_recipient", validate_recipient)?;
    cx.export_function("wcash_send_and_broadcast", send_and_broadcast)?;
    cx.export_function(
        "wcash_shield_coinbase_and_broadcast",
        shield_coinbase_and_broadcast,
    )?;
    cx.export_function("wcash_pending_transactions", pending_transactions)?;
    cx.export_function("wcash_rebroadcast_pending", rebroadcast_pending)?;
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

fn require_exact_object_keys(
    object: &Map<String, Value>,
    required: &[&str],
    allowed: &[&str],
    context: &str,
) -> Result<(), String> {
    if required.iter().any(|key| !object.contains_key(*key))
        || object.keys().any(|key| !allowed.contains(&key.as_str()))
    {
        return Err(format!("{context} has missing or unknown fields"));
    }
    Ok(())
}

fn format_wcash_amount(amount_zat: u64) -> String {
    let whole = amount_zat / ZATOSHIS_PER_WEC;
    let fraction = amount_zat % ZATOSHIS_PER_WEC;
    if fraction == 0 {
        return whole.to_string();
    }

    let mut fraction = format!("{fraction:08}");
    while fraction.ends_with('0') {
        fraction.pop();
    }
    format!("{whole}.{fraction}")
}

/// Converts one canonical WEC decimal string to zatoshis without floating
/// point. Canonical strings have no sign, exponent, whitespace, redundant
/// leading zero, or redundant fractional trailing zero.
fn parse_canonical_wcash_amount(amount: &str) -> Result<u64, String> {
    if amount.is_empty() || !amount.is_ascii() {
        return Err("amount must be a canonical ASCII decimal string".to_owned());
    }

    let mut pieces = amount.split('.');
    let whole = pieces.next().unwrap_or_default();
    let fraction = pieces.next();
    if pieces.next().is_some()
        || whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || (whole.len() > 1 && whole.starts_with('0'))
    {
        return Err("amount must be a canonical decimal string".to_owned());
    }

    let whole = whole
        .parse::<u64>()
        .map_err(|_| "amount is outside the supported accepted range".to_owned())?;
    let fractional_zat = match fraction {
        None => 0,
        Some(digits)
            if !digits.is_empty()
                && digits.len() <= 8
                && digits.bytes().all(|byte| byte.is_ascii_digit())
                && !digits.ends_with('0') =>
        {
            let value = digits
                .parse::<u64>()
                .map_err(|_| "amount has an invalid fractional component".to_owned())?;
            value * 10u64.pow(8 - digits.len() as u32)
        }
        Some(_) => return Err("amount must use at most 8 non-redundant decimal places".to_owned()),
    };

    let amount_zat = whole
        .checked_mul(ZATOSHIS_PER_WEC)
        .and_then(|value| value.checked_add(fractional_zat))
        .ok_or_else(|| "amount is outside the accepted range".to_owned())?;
    if amount_zat == 0 || amount_zat > WCASH_MAX_SUPPLY_ZAT {
        return Err("amount must be between 0.00000001 and 21000000 WEC".to_owned());
    }
    if format_wcash_amount(amount_zat) != amount {
        return Err("amount is not in canonical decimal form".to_owned());
    }
    Ok(amount_zat)
}

fn parse_send_request(request_json: &str) -> Result<Vec<WcashTestnetPayment>, String> {
    if request_json.len() > MAX_SEND_REQUEST_BYTES {
        return Err(format!(
            "send request exceeds the {MAX_SEND_REQUEST_BYTES}-byte limit"
        ));
    }

    let request: Value = serde_json::from_str(request_json)
        .map_err(|error| format!("send request is not valid JSON: {error}"))?;
    let request = request
        .as_object()
        .ok_or_else(|| "send request must be a JSON object".to_owned())?;
    require_exact_object_keys(request, &["payments"], &["payments"], "send request")?;
    let payments = request["payments"]
        .as_array()
        .ok_or_else(|| "payments must be a JSON array".to_owned())?;
    if payments.is_empty() || payments.len() > MAX_TRANSFER_RECIPIENTS {
        return Err(format!(
            "payments must contain 1 through {MAX_TRANSFER_RECIPIENTS} entries"
        ));
    }

    let mut total_zat = 0u64;
    payments
        .iter()
        .enumerate()
        .map(|(index, payment)| {
            let context = format!("payments[{index}]");
            let payment = payment
                .as_object()
                .ok_or_else(|| format!("{context} must be a JSON object"))?;
            require_exact_object_keys(
                payment,
                &["address", "amount"],
                &["address", "amount", "memo"],
                &context,
            )?;

            let address = payment["address"]
                .as_str()
                .ok_or_else(|| format!("{context}.address must be a string"))?;
            if address.is_empty() || address.len() > MAX_RECIPIENT_ADDRESS_BYTES {
                return Err(format!(
                    "{context}.address must contain 1 through {MAX_RECIPIENT_ADDRESS_BYTES} bytes"
                ));
            }
            decode_recipient(address, WalletNetwork::Testnet).map_err(|error| {
                format!("{context}.address is not a Wcash Testnet Ironwood recipient: {error}")
            })?;

            let amount = payment["amount"]
                .as_str()
                .ok_or_else(|| format!("{context}.amount must be a string"))?;
            let amount_zat = parse_canonical_wcash_amount(amount)
                .map_err(|error| format!("{context}.amount: {error}"))?;
            total_zat = total_zat
                .checked_add(amount_zat)
                .ok_or_else(|| "payment total is outside the accepted range".to_owned())?;
            if total_zat > WCASH_MAX_SUPPLY_ZAT {
                return Err("payment total exceeds the 21000000 WEC supply cap".to_owned());
            }

            let memo = match payment.get("memo") {
                None => Vec::new(),
                Some(value) => {
                    let memo = value
                        .as_str()
                        .ok_or_else(|| format!("{context}.memo must be a UTF-8 string"))?;
                    if memo.len() > MAX_MEMO_BYTES {
                        return Err(format!(
                            "{context}.memo exceeds the {MAX_MEMO_BYTES}-byte limit"
                        ));
                    }
                    memo.as_bytes().to_vec()
                }
            };

            Ok(WcashTestnetPayment {
                address: address.to_owned(),
                amount_zat,
                memo,
            })
        })
        .collect()
}

fn is_canonical_cursor(cursor: &str) -> bool {
    !cursor.is_empty()
        && cursor.bytes().all(|byte| byte.is_ascii_digit())
        && (cursor == "0" || !cursor.starts_with('0'))
}

fn parse_pending_cursor(cursor: &str) -> Result<u64, String> {
    if !is_canonical_cursor(cursor) {
        return Err(
            "pending transaction cursor must be a canonical unsigned decimal string".to_owned(),
        );
    }
    cursor
        .parse::<u64>()
        .map_err(|_| "pending transaction cursor is outside the accepted range".to_owned())
}

fn is_canonical_txid(txid: &str) -> bool {
    txid.len() == 64
        && txid
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn require_mnemonic_owns_wallet(mnemonic: &Mnemonic<English>) -> Result<(), ZingolibError> {
    let (ironwood, transparent) = mnemonic_receivers(mnemonic)?;
    let wallet = WcashTestnetRuntime::inspect(wallet_path()?)
        .map_err(|error| ZingolibError::Read(format!("inspect Wcash Testnet wallet: {error}")))?;
    if !receiver_pair_matches(
        &ironwood,
        &transparent,
        &wallet.address,
        &wallet.transparent_coinbase_address,
    ) {
        return Err(ZingolibError::Init(
            "recovery phrase does not control this Wcash Testnet wallet".to_owned(),
        ));
    }
    Ok(())
}

fn ensure_no_pending_transactions(runtime: &WcashTestnetRuntime) -> Result<(), ZingolibError> {
    let page = runtime.pending_transactions(None, 1).map_err(|error| {
        ZingolibError::Read(format!("inspect pending Wcash transactions: {error}"))
    })?;
    if let Some(transaction) = page.transactions.first() {
        return Err(ZingolibError::Init(format!(
            "pending signed transaction {} must settle or be rebroadcast before signing another transaction",
            transaction.txid
        )));
    }
    Ok(())
}

struct PublicTransactionMetadata<'a> {
    txid: &'a str,
    branch_id: &'a str,
    expiry_height: u32,
    target_height: Option<u32>,
    fee_zat: Option<u64>,
    internal_change_receiver_verified: Option<bool>,
}

fn transaction_result_json<E: std::fmt::Display>(
    operation: &str,
    transaction: PublicTransactionMetadata<'_>,
    broadcast: Result<BroadcastResult, E>,
) -> String {
    let PublicTransactionMetadata {
        txid,
        branch_id,
        expiry_height,
        target_height,
        fee_zat,
        internal_change_receiver_verified,
    } = transaction;
    match broadcast {
        Ok(broadcast) => serde_json::json!({
            "schema_version": TRANSACTION_SCHEMA_VERSION,
            "operation": operation,
            "outcome": "broadcast",
            "txid": txid,
            "branch_id": branch_id,
            "expiry_height": expiry_height,
            "target_height": target_height,
            "fee_zat": fee_zat.map(|fee| fee.to_string()),
            "internal_change_receiver_verified": internal_change_receiver_verified,
            "broadcast": broadcast,
            "recovery": null,
        })
        .to_string(),
        Err(error) => serde_json::json!({
            "schema_version": TRANSACTION_SCHEMA_VERSION,
            "operation": operation,
            "outcome": "recovery_required",
            "txid": txid,
            "branch_id": branch_id,
            "expiry_height": expiry_height,
            "target_height": target_height,
            "fee_zat": fee_zat.map(|fee| fee.to_string()),
            "internal_change_receiver_verified": internal_change_receiver_verified,
            "broadcast": null,
            "recovery": {
                "code": RECOVERY_REQUIRED_CODE,
                "message": error.to_string(),
            },
        })
        .to_string(),
    }
}

fn signed_transaction_result_json<E: std::fmt::Display>(
    operation: &str,
    signed: &SignedTransaction,
    broadcast: Result<BroadcastResult, E>,
) -> String {
    transaction_result_json(
        operation,
        PublicTransactionMetadata {
            txid: &signed.txid,
            branch_id: &signed.branch_id,
            expiry_height: signed.expiry_height,
            target_height: Some(signed.target_height),
            fee_zat: Some(signed.fee_zat),
            internal_change_receiver_verified: Some(signed.internal_change_receiver_verified),
        },
        broadcast,
    )
}

fn stored_transaction_result_json<E: std::fmt::Display>(
    signed: &StoredSignedTransaction,
    broadcast: Result<BroadcastResult, E>,
) -> String {
    transaction_result_json(
        "rebroadcast_pending",
        PublicTransactionMetadata {
            txid: &signed.txid,
            branch_id: &signed.branch_id,
            expiry_height: signed.expiry_height,
            target_height: None,
            fee_zat: None,
            internal_change_receiver_verified: None,
        },
        broadcast,
    )
}

fn public_pending_page_json(
    transactions: &[StoredSignedTransaction],
    next_after_row_id: Option<u64>,
) -> String {
    let transactions = transactions
        .iter()
        .map(|transaction| {
            serde_json::json!({
                "txid": transaction.txid,
                "branch_id": transaction.branch_id,
                "expiry_height": transaction.expiry_height,
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "schema_version": TRANSACTION_SCHEMA_VERSION,
        "transactions": transactions,
        "next_cursor": next_after_row_id.map(|cursor| cursor.to_string()),
    })
    .to_string()
}

fn find_pending_transaction(
    runtime: &WcashTestnetRuntime,
    txid: &str,
) -> Result<StoredSignedTransaction, ZingolibError> {
    let mut after_row_id = None;
    loop {
        let page = runtime
            .pending_transactions(after_row_id, MAX_PENDING_TRANSACTION_PAGE_SIZE)
            .map_err(|error| {
                ZingolibError::Read(format!("inspect pending Wcash transactions: {error}"))
            })?;
        if let Some(transaction) = page
            .transactions
            .into_iter()
            .find(|transaction| transaction.txid == txid)
        {
            return Ok(transaction);
        }

        match page.next_after_row_id {
            Some(next) if after_row_id.is_none_or(|previous| next > previous) => {
                after_row_id = Some(next);
            }
            Some(_) => {
                return Err(ZingolibError::Read(
                    "pending transaction pagination did not advance".to_owned(),
                ));
            }
            None => {
                return Err(ZingolibError::Read(format!(
                    "pending signed transaction {txid} was not found"
                )));
            }
        }
    }
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

fn validate_recipient(mut cx: FunctionContext) -> JsResult<JsString> {
    if cx.len() != 1 {
        return cx.throw_type_error("wcash_validate_recipient expects exactly one address string");
    }
    let address = cx.argument::<JsString>(0)?.value(&mut cx);
    let result = if !address.is_empty() && address.len() <= MAX_RECIPIENT_ADDRESS_BYTES {
        match decode_recipient(&address, WalletNetwork::Testnet) {
            Ok(_) => serde_json::json!({
                "schema_version": TRANSACTION_SCHEMA_VERSION,
                "valid": true,
                "network": "Wcash Testnet",
                "recipient_kind": "ironwood",
                "canonical_address": address,
                "error": null,
            }),
            Err(error) => serde_json::json!({
                "schema_version": TRANSACTION_SCHEMA_VERSION,
                "valid": false,
                "network": "Wcash Testnet",
                "recipient_kind": null,
                "canonical_address": null,
                "error": {
                    "code": "invalid_recipient",
                    "message": error.to_string(),
                },
            }),
        }
    } else {
        serde_json::json!({
            "schema_version": TRANSACTION_SCHEMA_VERSION,
            "valid": false,
            "network": "Wcash Testnet",
            "recipient_kind": null,
            "canonical_address": null,
            "error": {
                "code": "invalid_recipient",
                "message": format!("recipient address must contain 1 through {MAX_RECIPIENT_ADDRESS_BYTES} bytes"),
            },
        })
    };
    Ok(cx.string(result.to_string()))
}

fn send_and_broadcast(mut cx: FunctionContext) -> JsResult<JsPromise> {
    if cx.len() != 2 {
        return cx.throw_type_error(
            "wcash_send_and_broadcast expects a recovery phrase and one strict request JSON string",
        );
    }
    let seed_phrase = Zeroizing::new(cx.argument::<JsString>(0)?.value(&mut cx));
    let request_json = cx.argument::<JsString>(1)?.value(&mut cx);
    json_promise(cx, move || {
        with_panic_guard(|| {
            let payments = parse_send_request(&request_json).map_err(|error| {
                ZingolibError::Init(format!("invalid Wcash send request: {error}"))
            })?;
            let mnemonic = parse_mnemonic(seed_phrase.as_str())?;
            require_mnemonic_owns_wallet(&mnemonic)?;
            let master_seed = mnemonic_master_seed(&mnemonic);
            let mut slot = WCASH_RUNTIME
                .lock()
                .map_err(|_| ZingolibError::Init("Wcash runtime lock poisoned".to_owned()))?;
            let runtime = slot
                .as_mut()
                .ok_or_else(|| ZingolibError::Init("Wcash wallet is not open".to_owned()))?;
            ensure_no_pending_transactions(runtime)?;

            let signed = RT
                .block_on(runtime.send(&master_seed, payments))
                .map_err(|error| ZingolibError::Init(format!("Wcash Testnet send: {error}")))?;
            let broadcast = RT.block_on(runtime.broadcast(&signed));
            Ok(signed_transaction_result_json("send", &signed, broadcast))
        })
    })
}

fn shield_coinbase_and_broadcast(mut cx: FunctionContext) -> JsResult<JsPromise> {
    if cx.len() != 1 {
        return cx.throw_type_error(
            "wcash_shield_coinbase_and_broadcast expects exactly one recovery phrase",
        );
    }
    let seed_phrase = Zeroizing::new(cx.argument::<JsString>(0)?.value(&mut cx));
    json_promise(cx, move || {
        with_panic_guard(|| {
            let mnemonic = parse_mnemonic(seed_phrase.as_str())?;
            require_mnemonic_owns_wallet(&mnemonic)?;
            let master_seed = mnemonic_master_seed(&mnemonic);
            let mut slot = WCASH_RUNTIME
                .lock()
                .map_err(|_| ZingolibError::Init("Wcash runtime lock poisoned".to_owned()))?;
            let runtime = slot
                .as_mut()
                .ok_or_else(|| ZingolibError::Init("Wcash wallet is not open".to_owned()))?;
            ensure_no_pending_transactions(runtime)?;

            let signed = RT
                .block_on(runtime.shield_coinbase(&master_seed))
                .map_err(|error| {
                    ZingolibError::Init(format!("Wcash Testnet coinbase shielding: {error}"))
                })?;
            let broadcast = RT.block_on(runtime.broadcast(&signed));
            Ok(signed_transaction_result_json(
                "shield_coinbase",
                &signed,
                broadcast,
            ))
        })
    })
}

fn pending_transactions(mut cx: FunctionContext) -> JsResult<JsPromise> {
    if cx.len() > 1 {
        return cx.throw_type_error(
            "wcash_pending_transactions expects zero arguments or one string cursor",
        );
    }
    let after_row_id = match cx.argument_opt(0) {
        None => None,
        Some(value)
            if value.is_a::<JsNull, _>(&mut cx) || value.is_a::<JsUndefined, _>(&mut cx) =>
        {
            None
        }
        Some(value) => {
            let value = value
                .downcast_or_throw::<JsString, _>(&mut cx)?
                .value(&mut cx);
            match parse_pending_cursor(&value) {
                Ok(cursor) => Some(cursor),
                Err(error) => return cx.throw_range_error(error),
            }
        }
    };

    json_promise(cx, move || {
        with_panic_guard(|| {
            let slot = WCASH_RUNTIME
                .lock()
                .map_err(|_| ZingolibError::Read("Wcash runtime lock poisoned".to_owned()))?;
            let runtime = slot
                .as_ref()
                .ok_or_else(|| ZingolibError::Read("Wcash wallet is not open".to_owned()))?;
            let page = runtime
                .pending_transactions(after_row_id, MAX_PENDING_TRANSACTION_PAGE_SIZE)
                .map_err(|error| {
                    ZingolibError::Read(format!("Wcash pending transactions: {error}"))
                })?;
            Ok(public_pending_page_json(
                &page.transactions,
                page.next_after_row_id,
            ))
        })
    })
}

fn rebroadcast_pending(mut cx: FunctionContext) -> JsResult<JsPromise> {
    if cx.len() != 1 {
        return cx.throw_type_error("wcash_rebroadcast_pending expects exactly one transaction ID");
    }
    let txid = cx.argument::<JsString>(0)?.value(&mut cx);
    if !is_canonical_txid(&txid) {
        return cx.throw_type_error(
            "Wcash transaction ID must be exactly 64 lowercase hexadecimal characters",
        );
    }

    json_promise(cx, move || {
        with_panic_guard(|| {
            let mut slot = WCASH_RUNTIME
                .lock()
                .map_err(|_| ZingolibError::Read("Wcash runtime lock poisoned".to_owned()))?;
            let runtime = slot
                .as_mut()
                .ok_or_else(|| ZingolibError::Read("Wcash wallet is not open".to_owned()))?;
            let signed = find_pending_transaction(runtime, &txid)?;
            let broadcast = RT.block_on(runtime.broadcast_pending(&signed));
            Ok(stored_transaction_result_json(&signed, broadcast))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wcash_wallet::{BroadcastDisposition, TransactionStatus};

    const TEST_IRONWOOD_RECIPIENT: &str = "wutest18rmpm4xcm2d54xg5mg00lac9pg4txaladyp6pacqhm355n5scpn5gja6hy43uqassvr63g6xuephu8r0qju92778lg4v5nkxfu7j3la6";

    fn send_request(payments: Value) -> String {
        serde_json::json!({ "payments": payments }).to_string()
    }

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

    #[test]
    fn canonical_wcash_amounts_use_exact_eight_decimal_base_units() {
        assert_eq!(parse_canonical_wcash_amount("0.00000001").unwrap(), 1);
        assert_eq!(parse_canonical_wcash_amount("0.1").unwrap(), 10_000_000);
        assert_eq!(parse_canonical_wcash_amount("1").unwrap(), 100_000_000);
        assert_eq!(
            parse_canonical_wcash_amount("21000000").unwrap(),
            WCASH_MAX_SUPPLY_ZAT
        );
        assert_eq!(format_wcash_amount(1), "0.00000001");
        assert_eq!(format_wcash_amount(123_450_000), "1.2345");
        assert_eq!(format_wcash_amount(WCASH_MAX_SUPPLY_ZAT), "21000000");
    }

    #[test]
    fn noncanonical_or_out_of_range_wcash_amounts_are_rejected() {
        for amount in [
            "",
            "0",
            "00.1",
            "01",
            "1.",
            ".1",
            "1.0",
            "1.230",
            "0.000000001",
            "+1",
            "-1",
            "1e2",
            " 1",
            "1 ",
            "21000000.00000001",
            "18446744073709551615",
        ] {
            assert!(
                parse_canonical_wcash_amount(amount).is_err(),
                "unexpectedly accepted {amount:?}"
            );
        }
    }

    #[test]
    fn strict_send_request_accepts_only_wcash_testnet_ironwood_payments() {
        let request = send_request(serde_json::json!([{
            "address": TEST_IRONWOOD_RECIPIENT,
            "amount": "1.25",
            "memo": "private memo",
        }]));
        let payments = parse_send_request(&request).unwrap();

        assert_eq!(payments.len(), 1);
        assert_eq!(payments[0].address, TEST_IRONWOOD_RECIPIENT);
        assert_eq!(payments[0].amount_zat, 125_000_000);
        assert_eq!(payments[0].memo, b"private memo");

        for address in [
            "WTMMWgVvepdG58zdNjePbtyoh4aSwb4kP3E",
            "tmQvJu83NwioWyV852dPCzNXhzdtXVJwMAJ",
            "",
        ] {
            let request = send_request(serde_json::json!([{
                "address": address,
                "amount": "1",
            }]));
            assert!(parse_send_request(&request).is_err());
        }

        let mnemonic = parse_mnemonic(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
        )
        .unwrap();
        let master_seed = mnemonic_master_seed(&mnemonic);
        let wrong_network_ufvk =
            derive_wallet_spending_key(&master_seed, WalletNetwork::Regtest, 0)
                .unwrap()
                .to_unified_full_viewing_key();
        let wrong_network_address =
            encode_orchard_receiver(&wrong_network_ufvk, WalletNetwork::Regtest).unwrap();
        let wrong_network = send_request(serde_json::json!([{
            "address": wrong_network_address,
            "amount": "1",
        }]));
        assert!(parse_send_request(&wrong_network).is_err());
    }

    #[test]
    fn strict_send_request_rejects_unknown_missing_and_wrong_typed_fields() {
        for request in [
            "null".to_owned(),
            "[]".to_owned(),
            "{}".to_owned(),
            serde_json::json!({ "payments": [], "extra": true }).to_string(),
            serde_json::json!({ "payments": "not-an-array" }).to_string(),
            send_request(serde_json::json!([null])),
            send_request(serde_json::json!([{
                "address": TEST_IRONWOOD_RECIPIENT,
            }])),
            send_request(serde_json::json!([{
                "address": TEST_IRONWOOD_RECIPIENT,
                "amount": 1,
            }])),
            send_request(serde_json::json!([{
                "address": TEST_IRONWOOD_RECIPIENT,
                "amount": "1",
                "memo": 7,
            }])),
            send_request(serde_json::json!([{
                "address": TEST_IRONWOOD_RECIPIENT,
                "amount": "1",
                "extra": true,
            }])),
        ] {
            assert!(
                parse_send_request(&request).is_err(),
                "unexpectedly accepted {request}"
            );
        }
    }

    #[test]
    fn strict_send_request_enforces_count_total_and_utf8_memo_byte_limits() {
        let one_payment = || {
            serde_json::json!({
                "address": TEST_IRONWOOD_RECIPIENT,
                "amount": "0.00000001",
            })
        };
        assert!(parse_send_request(&send_request(Value::Array(vec![]))).is_err());
        assert!(parse_send_request(&send_request(Value::Array(
            (0..=MAX_TRANSFER_RECIPIENTS)
                .map(|_| one_payment())
                .collect()
        )))
        .is_err());
        assert!(parse_send_request(&send_request(Value::Array(
            (0..MAX_TRANSFER_RECIPIENTS)
                .map(|_| one_payment())
                .collect()
        )))
        .is_ok());

        let over_supply = send_request(serde_json::json!([
            { "address": TEST_IRONWOOD_RECIPIENT, "amount": "21000000" },
            { "address": TEST_IRONWOOD_RECIPIENT, "amount": "0.00000001" },
        ]));
        assert!(parse_send_request(&over_supply).is_err());

        let exactly_512_utf8_bytes = "é".repeat(256);
        let too_many_utf8_bytes = "é".repeat(257);
        let accepted = send_request(serde_json::json!([{
            "address": TEST_IRONWOOD_RECIPIENT,
            "amount": "1",
            "memo": exactly_512_utf8_bytes,
        }]));
        let rejected = send_request(serde_json::json!([{
            "address": TEST_IRONWOOD_RECIPIENT,
            "amount": "1",
            "memo": too_many_utf8_bytes,
        }]));
        assert_eq!(parse_send_request(&accepted).unwrap()[0].memo.len(), 512);
        assert!(parse_send_request(&rejected).is_err());
    }

    #[test]
    fn pending_cursors_and_transaction_ids_are_canonical_strings() {
        assert_eq!(parse_pending_cursor("0").unwrap(), 0);
        assert_eq!(parse_pending_cursor("42").unwrap(), 42);
        for cursor in ["", "00", "01", "+1", "-1", "1.0", " 1"] {
            assert!(parse_pending_cursor(cursor).is_err());
        }

        assert!(is_canonical_txid(&"a".repeat(64)));
        assert!(is_canonical_txid(&"09".repeat(32)));
        assert!(!is_canonical_txid(&"A".repeat(64)));
        assert!(!is_canonical_txid(&"a".repeat(63)));
        assert!(!is_canonical_txid(&"g".repeat(64)));
    }

    #[test]
    fn pending_page_never_serializes_signed_transaction_bytes() {
        let pending = StoredSignedTransaction {
            txid: "ab".repeat(32),
            raw_transaction_hex: "sensitive-raw-transaction-bytes".to_owned(),
            branch_id: "b3cfd27e".to_owned(),
            expiry_height: 123,
        };
        let output = public_pending_page_json(&[pending], Some(7));
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["schema_version"], 1);
        assert_eq!(parsed["next_cursor"], "7");
        assert_eq!(parsed["transactions"][0]["txid"], "ab".repeat(32));
        assert!(parsed["transactions"][0]
            .get("raw_transaction_hex")
            .is_none());
        assert!(!output.contains("sensitive-raw-transaction-bytes"));
    }

    #[test]
    fn broadcast_error_after_signing_returns_recovery_required_not_raw_bytes() {
        let signed = SignedTransaction {
            txid: "cd".repeat(32),
            raw_transaction_hex: "sensitive-signed-transaction-bytes".to_owned(),
            branch_id: "b3cfd27e".to_owned(),
            target_height: 100,
            expiry_height: 140,
            fee_zat: 10_000,
            internal_change_receiver_verified: true,
        };
        let output = signed_transaction_result_json(
            "send",
            &signed,
            Result::<BroadcastResult, _>::Err("network acknowledgement lost"),
        );
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["schema_version"], 1);
        assert_eq!(parsed["operation"], "send");
        assert_eq!(parsed["outcome"], "recovery_required");
        assert_eq!(parsed["txid"], signed.txid);
        assert_eq!(parsed["fee_zat"], "10000");
        assert_eq!(parsed["broadcast"], Value::Null);
        assert_eq!(parsed["recovery"]["code"], RECOVERY_REQUIRED_CODE);
        assert!(parsed.get("raw_transaction_hex").is_none());
        assert!(!output.contains("sensitive-signed-transaction-bytes"));
    }

    #[test]
    fn successful_broadcast_envelope_exposes_only_public_transaction_metadata() {
        let txid = "ef".repeat(32);
        let signed = SignedTransaction {
            txid: txid.clone(),
            raw_transaction_hex: "never-export-this-serialization".to_owned(),
            branch_id: "b3cfd27e".to_owned(),
            target_height: 101,
            expiry_height: 141,
            fee_zat: 20_000,
            internal_change_receiver_verified: true,
        };
        let broadcast = BroadcastResult {
            txid: txid.clone(),
            disposition: BroadcastDisposition::Submitted,
            status: TransactionStatus::Mempool,
        };
        let output = signed_transaction_result_json(
            "shield_coinbase",
            &signed,
            Result::<_, &str>::Ok(broadcast),
        );
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["operation"], "shield_coinbase");
        assert_eq!(parsed["outcome"], "broadcast");
        assert_eq!(parsed["txid"], txid);
        assert_eq!(parsed["broadcast"]["disposition"], "submitted");
        assert_eq!(parsed["broadcast"]["status"]["state"], "mempool");
        assert_eq!(parsed["recovery"], Value::Null);
        assert!(parsed.get("raw_transaction_hex").is_none());
        assert!(!output.contains("never-export-this-serialization"));
    }
}
