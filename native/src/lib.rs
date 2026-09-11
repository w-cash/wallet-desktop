//! Native boundary for Wcash Warden Testnet.
//!
//! The original Zingo native bridge is preserved in 'legacy_zcash.rs' for
//! reference while the product is migrated, but it is deliberately not linked
//! into this Wcash build. Only fixed-network wallet operations and generic
//! platform authentication are exported.

mod wcash;

use std::panic::{self, UnwindSafe};
use std::path::PathBuf;

use neon::prelude::*;
use once_cell::sync::{Lazy, OnceCell};
use tokio::runtime::Runtime;

#[cfg(target_os = "macos")]
extern "C" {
    fn check_mac_auth_available() -> std::ffi::c_int;
    fn verify_mac_auth_sync(reason: *const std::ffi::c_char) -> std::ffi::c_int;
}

pub(crate) static WALLET_BASE_DIR: OnceCell<PathBuf> = OnceCell::new();
pub(crate) static RT: Lazy<Runtime> =
    Lazy::new(|| Runtime::new().expect("create Wcash Tokio runtime"));

#[derive(Debug, thiserror::Error)]
pub enum ZingolibError {
    #[error("native operation panicked")]
    Panic,
    #[error("initializing wallet: {0}")]
    Init(String),
    #[error("synchronizing wallet: {0}")]
    Sync(String),
    #[error("reading wallet: {0}")]
    Read(String),
}

pub fn with_panic_guard<T, F>(work: F) -> Result<T, ZingolibError>
where
    F: FnOnce() -> Result<T, ZingolibError> + UnwindSafe,
{
    panic::catch_unwind(work).unwrap_or(Err(ZingolibError::Panic))
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    wcash::export(&mut cx)?;
    cx.export_function("set_wallet_base_dir", set_wallet_base_dir)?;

    #[cfg(target_os = "windows")]
    cx.export_function("checkWindowsHello", check_windows_hello)?;
    #[cfg(target_os = "windows")]
    cx.export_function("verifyWindowsUser", verify_windows_user)?;

    #[cfg(target_os = "macos")]
    cx.export_function("checkMacAuth", check_mac_auth)?;
    #[cfg(target_os = "macos")]
    cx.export_function("verifyMacUser", verify_mac_user)?;

    Ok(())
}

fn set_wallet_base_dir(mut cx: FunctionContext) -> JsResult<JsBoolean> {
    let path = PathBuf::from(cx.argument::<JsString>(0)?.value(&mut cx));
    if !path.is_absolute() {
        return cx.throw_type_error("Wcash wallet base directory must be absolute");
    }

    let configured = match WALLET_BASE_DIR.get() {
        Some(existing) => existing == &path,
        None => WALLET_BASE_DIR.set(path).is_ok(),
    };
    Ok(cx.boolean(configured))
}

#[cfg(target_os = "windows")]
fn check_windows_hello(mut cx: FunctionContext) -> JsResult<JsString> {
    use windows::Security::Credentials::UI::{
        UserConsentVerifier, UserConsentVerifierAvailability,
    };

    let status = panic::catch_unwind(|| match UserConsentVerifier::CheckAvailabilityAsync() {
        Ok(operation) => match operation.get() {
            Ok(value) if value == UserConsentVerifierAvailability::Available => "available",
            Ok(value) if value == UserConsentVerifierAvailability::NotConfiguredForUser => {
                "not_configured"
            }
            _ => "not_supported",
        },
        Err(_) => "not_supported",
    });

    Ok(cx.string(status.unwrap_or("not_supported")))
}

#[cfg(target_os = "windows")]
fn verify_windows_user(mut cx: FunctionContext) -> JsResult<JsPromise> {
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier};

    let reason = cx.argument::<JsString>(0)?.value(&mut cx);
    let channel = cx.channel();
    let (deferred, promise) = cx.promise();

    std::thread::spawn(move || {
        let success = panic::catch_unwind(|| {
            let reason = HSTRING::from(reason.as_str());
            match UserConsentVerifier::RequestVerificationAsync(&reason) {
                Ok(operation) => operation
                    .get()
                    .is_ok_and(|result| result == UserConsentVerificationResult::Verified),
                Err(_) => false,
            }
        })
        .unwrap_or(false);

        deferred.settle_with(&channel, move |mut cx| {
            let result = cx.empty_object();
            let value = cx.boolean(success);
            result.set(&mut cx, "success", value)?;
            Ok(result)
        });
    });

    Ok(promise)
}

#[cfg(target_os = "macos")]
fn check_mac_auth(mut cx: FunctionContext) -> JsResult<JsString> {
    let available = unsafe { check_mac_auth_available() != 0 };
    Ok(cx.string(if available {
        "available"
    } else {
        "not_supported"
    }))
}

#[cfg(target_os = "macos")]
fn verify_mac_user(mut cx: FunctionContext) -> JsResult<JsPromise> {
    use std::ffi::CString;

    let reason = cx.argument::<JsString>(0)?.value(&mut cx);
    let channel = cx.channel();
    let (deferred, promise) = cx.promise();

    std::thread::spawn(move || {
        let reason = CString::new(reason).unwrap_or_else(|_| CString::new("Authenticate").unwrap());
        let success = unsafe { verify_mac_auth_sync(reason.as_ptr()) != 0 };

        deferred.settle_with(&channel, move |mut cx| {
            let result = cx.empty_object();
            let value = cx.boolean(success);
            result.set(&mut cx, "success", value)?;
            Ok(result)
        });
    });

    Ok(promise)
}
