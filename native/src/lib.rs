//! Native boundary for Wcash Warden.
//!
//! The original Zingo native bridge is preserved in 'legacy_zcash.rs' for
//! reference while the product is migrated, but it is deliberately not linked
//! into this Wcash build. Only fixed-network wallet operations and generic
//! platform authentication are exported.

#[cfg(all(feature = "wcash-testnet", feature = "wcash-regtest"))]
compile_error!(
    "select exactly one Wcash native profile; Regtest builds must disable default features"
);
#[cfg(not(any(feature = "wcash-testnet", feature = "wcash-regtest")))]
compile_error!("select exactly one Wcash native profile");

mod wcash;

use std::panic::{self, UnwindSafe};
use std::path::PathBuf;

use neon::prelude::*;
use once_cell::sync::{Lazy, OnceCell};
use tokio::runtime::Runtime;

#[cfg(target_os = "macos")]
extern "C" {
    fn check_mac_auth_available() -> std::ffi::c_int;
    fn verify_mac_auth_sync(
        reason: *const std::ffi::c_char,
        timeout_millis: u64,
    ) -> std::ffi::c_int;
}

pub(crate) static WALLET_BASE_DIR: OnceCell<PathBuf> = OnceCell::new();
pub(crate) static RT: Lazy<Runtime> =
    Lazy::new(|| Runtime::new().expect("create Wcash Tokio runtime"));

#[cfg(any(target_os = "windows", test))]
const MAX_AUTH_REASON_BYTES: usize = 256;

#[cfg(any(target_os = "windows", test))]
fn valid_auth_reason(reason: &str) -> bool {
    !reason.is_empty()
        && reason.len() <= MAX_AUTH_REASON_BYTES
        && !reason.chars().any(char::is_control)
}

#[cfg(any(target_os = "windows", test))]
fn parse_native_window_handle(bytes: &[u8]) -> Option<usize> {
    if bytes.len() != std::mem::size_of::<usize>() {
        return None;
    }

    let mut native_bytes = [0_u8; std::mem::size_of::<usize>()];
    native_bytes.copy_from_slice(bytes);
    let handle = usize::from_ne_bytes(native_bytes);
    (handle != 0).then_some(handle)
}

#[cfg(target_os = "windows")]
struct WindowsRuntime;

#[cfg(target_os = "windows")]
impl WindowsRuntime {
    fn initialize() -> windows::core::Result<Self> {
        use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

        unsafe { RoInitialize(RO_INIT_MULTITHREADED)? };
        Ok(Self)
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsRuntime {
    fn drop(&mut self) {
        use windows::Win32::System::WinRT::RoUninitialize;

        unsafe { RoUninitialize() };
    }
}

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
fn check_windows_hello(mut cx: FunctionContext) -> JsResult<JsPromise> {
    use windows::Security::Credentials::UI::{
        UserConsentVerifier, UserConsentVerifierAvailability,
    };

    let channel = cx.channel();
    let (deferred, promise) = cx.promise();

    std::thread::spawn(move || {
        let status = panic::catch_unwind(|| {
            let Ok(_runtime) = WindowsRuntime::initialize() else {
                return "not_supported";
            };
            match UserConsentVerifier::CheckAvailabilityAsync() {
                Ok(operation) => match operation.get() {
                    Ok(value) if value == UserConsentVerifierAvailability::Available => "available",
                    Ok(value) if value == UserConsentVerifierAvailability::NotConfiguredForUser => {
                        "not_configured"
                    }
                    _ => "not_supported",
                },
                Err(_) => "not_supported",
            }
        })
        .unwrap_or("not_supported");

        deferred.settle_with(&channel, move |mut cx| Ok(cx.string(status)));
    });

    Ok(promise)
}

#[cfg(target_os = "windows")]
fn verify_windows_user(mut cx: FunctionContext) -> JsResult<JsPromise> {
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
    use windows_future::IAsyncOperation;

    let handle_bytes = cx.argument::<JsBuffer>(0)?.as_slice(&cx).to_vec();
    let Some(window_handle) = parse_native_window_handle(&handle_bytes) else {
        return cx.throw_type_error("Windows owner handle is invalid");
    };
    let reason = cx.argument::<JsString>(1)?.value(&mut cx);
    if !valid_auth_reason(&reason) {
        return cx.throw_range_error("Windows authentication reason is invalid");
    }
    let channel = cx.channel();
    let (deferred, promise) = cx.promise();

    std::thread::spawn(move || {
        let success = panic::catch_unwind(|| {
            let Ok(_runtime) = WindowsRuntime::initialize() else {
                return false;
            };
            let Ok(interop) =
                windows::core::factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
            else {
                return false;
            };
            let reason = HSTRING::from(reason.as_str());
            let owner = HWND(window_handle as *mut std::ffi::c_void);
            let operation = unsafe {
                interop.RequestVerificationForWindowAsync::<
                    IAsyncOperation<UserConsentVerificationResult>,
                >(owner, &reason)
            };
            match operation {
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
        // End the native LocalAuthentication request before the outer JS
        // watchdog, so a timeout cannot leave a hidden prompt or permit an
        // overlapping retry.
        let success = unsafe { verify_mac_auth_sync(reason.as_ptr(), 55_000) != 0 };

        deferred.settle_with(&channel, move |mut cx| {
            let result = cx.empty_object();
            let value = cx.boolean(success);
            result.set(&mut cx, "success", value)?;
            Ok(result)
        });
    });

    Ok(promise)
}

#[cfg(test)]
mod authentication_tests {
    use super::{parse_native_window_handle, valid_auth_reason, MAX_AUTH_REASON_BYTES};

    #[test]
    fn accepts_one_nonzero_native_window_handle() {
        let expected = 0x1234_usize;
        assert_eq!(
            parse_native_window_handle(&expected.to_ne_bytes()),
            Some(expected)
        );
    }

    #[test]
    fn rejects_zero_and_wrong_sized_window_handles() {
        let valid = 0x1234_usize.to_ne_bytes();
        assert_eq!(parse_native_window_handle(&0_usize.to_ne_bytes()), None);
        assert_eq!(parse_native_window_handle(&valid[..valid.len() - 1]), None);

        let mut oversized = valid.to_vec();
        oversized.push(0);
        assert_eq!(parse_native_window_handle(&oversized), None);
    }

    #[test]
    fn bounds_authentication_reason_text() {
        assert!(valid_auth_reason("Authorize Wcash Testnet transaction"));
        assert!(!valid_auth_reason(""));
        assert!(!valid_auth_reason("line\nbreak"));
        assert!(!valid_auth_reason(&"x".repeat(MAX_AUTH_REASON_BYTES + 1)));
    }
}
