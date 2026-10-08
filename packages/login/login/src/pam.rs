//! A small hand-written binding of libpam (Linux-PAM's application API, security/pam_appl.h): one handle per sign-in,
//! from pam_start to pam_end. All of the production helper's unsafe code is here; the conversation's logic (what the
//! page is asked, the answers' limits) is in relay.rs, this module only moves C strings in and out.
//!
//! Linked against `libpam.so.0` itself, so building needs no PAM development package.
#![allow(unsafe_code)]

use crate::attempt::{Pam, Refusal};
use crate::relay::{wipe, Relay, PAM_MAX_NUM_MSG};
use libc::{c_char, c_int, c_void};
use std::ffi::{CStr, CString};
use std::net::IpAddr;

#[repr(C)]
struct PamHandleT {
    _private: [u8; 0],
}

#[repr(C)]
struct PamMessage {
    msg_style: c_int,
    msg: *const c_char,
}

#[repr(C)]
struct PamResponse {
    resp: *mut c_char,
    resp_retcode: c_int,
}

type ConversationFn = extern "C" fn(c_int, *mut *const PamMessage, *mut *mut PamResponse, *mut c_void) -> c_int;

#[repr(C)]
struct PamConv {
    conv: ConversationFn,
    appdata_ptr: *mut c_void,
}

const PAM_SUCCESS: c_int = 0;
const PAM_BUF_ERR: c_int = 5;
const PAM_NEW_AUTHTOK_REQD: c_int = 12;
const PAM_CONV_ERR: c_int = 19;
const PAM_USER: c_int = 2;
const PAM_TTY: c_int = 3;
const PAM_RHOST: c_int = 4;
const PAM_DISALLOW_NULL_AUTHTOK: c_int = 0x0001;
const PAM_ESTABLISH_CRED: c_int = 0x0002;
const PAM_DELETE_CRED: c_int = 0x0004;

#[link(name = "libpam.so.0", kind = "dylib", modifiers = "+verbatim")]
extern "C" {
    fn pam_start(service: *const c_char, user: *const c_char, conv: *const PamConv, pamh: *mut *mut PamHandleT) -> c_int;
    fn pam_end(pamh: *mut PamHandleT, status: c_int) -> c_int;
    fn pam_authenticate(pamh: *mut PamHandleT, flags: c_int) -> c_int;
    fn pam_acct_mgmt(pamh: *mut PamHandleT, flags: c_int) -> c_int;
    fn pam_setcred(pamh: *mut PamHandleT, flags: c_int) -> c_int;
    fn pam_open_session(pamh: *mut PamHandleT, flags: c_int) -> c_int;
    fn pam_close_session(pamh: *mut PamHandleT, flags: c_int) -> c_int;
    fn pam_set_item(pamh: *mut PamHandleT, item_type: c_int, item: *const c_void) -> c_int;
    fn pam_get_item(pamh: *const PamHandleT, item_type: c_int, item: *mut *const c_void) -> c_int;
    fn pam_strerror(pamh: *mut PamHandleT, errnum: c_int) -> *const c_char;
    fn pam_putenv(pamh: *mut PamHandleT, name_value: *const c_char) -> c_int;
    fn pam_getenvlist(pamh: *mut PamHandleT) -> *mut *mut c_char;
}

/// One PAM transaction. The relay (the conversation's connection to the page) lives as long as the handle: PAM holds a
/// pointer to it.
pub struct Handle {
    pamh: *mut PamHandleT,
    relay: *mut Relay,
    /// PAM keeps a pointer to the conversation struct on some implementations: it lives as long as the handle
    _conversation: Box<PamConv>,
    /// the last PAM result, for pam_end
    status: c_int,
    credentials: bool,
    session: bool,
}

/// Turn C strings into Rust ones, lossily (PAM's texts are for people).
fn text(pointer: *const c_char) -> String {
    if pointer.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned()
    }
}

/// PAM's conversation function: hand the messages to the relay, copy its answers into malloc'd responses (PAM frees
/// them). Our answers are wiped once copied.
extern "C" fn conversation(
    count: c_int,
    messages: *mut *const PamMessage,
    responses: *mut *mut PamResponse,
    data: *mut c_void,
) -> c_int {
    if count <= 0 || count as usize > PAM_MAX_NUM_MSG || messages.is_null() || responses.is_null() || data.is_null() {
        return PAM_CONV_ERR;
    }
    let relay = unsafe { &mut *(data as *mut Relay) };
    let mut list = Vec::with_capacity(count as usize);
    for i in 0..count as usize {
        // Linux-PAM's layout: an array of pointers to messages
        let message = unsafe { *messages.add(i) };
        if message.is_null() {
            return PAM_CONV_ERR;
        }
        let (style, msg) = unsafe { ((*message).msg_style, (*message).msg) };
        list.push((style, text(msg)));
    }
    let answers = match relay.converse(&list) {
        Ok(answers) => answers,
        Err(e) => {
            nebula_login_common::log::info(&format!("PAM's conversation failed: {e}"));
            return PAM_CONV_ERR;
        }
    };
    let replies = unsafe { libc::calloc(count as usize, std::mem::size_of::<PamResponse>()) } as *mut PamResponse;
    if replies.is_null() {
        answers.into_iter().flatten().for_each(wipe);
        return PAM_BUF_ERR;
    }
    let mut failed = false;
    for (i, answer) in answers.into_iter().enumerate() {
        let Some(answer) = answer else { continue };
        if !failed {
            // (the relay refused answers with a NUL byte)
            let bytes = answer.as_bytes();
            let copy = unsafe { libc::malloc(bytes.len() + 1) } as *mut u8;
            if copy.is_null() {
                failed = true;
            } else {
                unsafe {
                    std::ptr::copy_nonoverlapping(bytes.as_ptr(), copy, bytes.len());
                    *copy.add(bytes.len()) = 0;
                    (*replies.add(i)).resp = copy as *mut c_char;
                }
            }
        }
        wipe(answer);
    }
    if failed {
        for i in 0..count as usize {
            let resp = unsafe { (*replies.add(i)).resp };
            if !resp.is_null() {
                unsafe {
                    std::ptr::write_bytes(resp, 0, libc::strlen(resp));
                    libc::free(resp as *mut c_void);
                }
            }
        }
        unsafe { libc::free(replies as *mut c_void) };
        return PAM_BUF_ERR;
    }
    unsafe { *responses = replies };
    PAM_SUCCESS
}

impl Handle {
    /// pam_start(`service`, `user`), then PAM_RHOST (the client's address), PAM_TTY and the session's type for
    /// pam_systemd. On failure the relay comes back.
    pub fn start(service: &str, user: &str, client: IpAddr, tty: &str, relay: Relay) -> Result<Handle, (Relay, String)> {
        let relay = Box::into_raw(Box::new(relay));
        let back = |message: String| (*unsafe { Box::from_raw(relay) }, message);
        let (Ok(service), Ok(user)) = (CString::new(service), CString::new(user)) else {
            return Err(back("a NUL byte in the service or user name".into()));
        };
        let conversation = Box::new(PamConv { conv: conversation, appdata_ptr: relay as *mut c_void });
        let mut pamh: *mut PamHandleT = std::ptr::null_mut();
        let status = unsafe { pam_start(service.as_ptr(), user.as_ptr(), &*conversation, &mut pamh) };
        if status != PAM_SUCCESS || pamh.is_null() {
            let message = if pamh.is_null() { format!("pam_start: error {status}") } else { strerror(pamh, status) };
            if !pamh.is_null() {
                unsafe { pam_end(pamh, status) };
            }
            return Err(back(message));
        }
        let mut handle =
            Handle { pamh, relay, _conversation: conversation, status, credentials: false, session: false };
        let items = [(PAM_RHOST, client.to_string()), (PAM_TTY, tty.to_string())];
        for (item, value) in items {
            if let Err(e) = handle.set_item(item, &value) {
                return Err(handle.into_relay(e));
            }
        }
        // read by pam_systemd when it registers the session with logind
        for variable in ["XDG_SESSION_TYPE=wayland", "XDG_SESSION_CLASS=user", "XDG_SESSION_DESKTOP=nebula"] {
            let variable = CString::new(variable).expect("no NUL");
            let status = unsafe { pam_putenv(handle.pamh, variable.as_ptr()) };
            if status != PAM_SUCCESS {
                let message = strerror(handle.pamh, status);
                return Err(handle.into_relay(format!("pam_putenv: {message}")));
            }
        }
        Ok(handle)
    }

    fn set_item(&mut self, item: c_int, value: &str) -> Result<(), String> {
        let value = CString::new(value).map_err(|_| "a NUL byte in a PAM item".to_string())?;
        self.status = unsafe { pam_set_item(self.pamh, item, value.as_ptr() as *const c_void) };
        if self.status != PAM_SUCCESS {
            return Err(format!("pam_set_item: {}", strerror(self.pamh, self.status)));
        }
        Ok(())
    }

    /// End the transaction, keeping the relay (to tell the page).
    fn into_relay(mut self, message: String) -> (Relay, String) {
        self.end();
        let relay = std::mem::replace(&mut self.relay, std::ptr::null_mut());
        (*unsafe { Box::from_raw(relay) }, message)
    }

    fn end(&mut self) {
        if !self.pamh.is_null() {
            unsafe { pam_end(self.pamh, self.status) };
            self.pamh = std::ptr::null_mut();
        }
    }

    fn call(&mut self, name: &str, result: c_int) -> Result<(), String> {
        self.status = result;
        if result != PAM_SUCCESS {
            return Err(format!("{name}: {}", strerror(self.pamh, result)));
        }
        Ok(())
    }
}

fn strerror(pamh: *mut PamHandleT, status: c_int) -> String {
    text(unsafe { pam_strerror(pamh, status) })
}

impl Pam for Handle {
    fn authenticate(&mut self) -> Result<(), Refusal> {
        let result = unsafe { pam_authenticate(self.pamh, PAM_DISALLOW_NULL_AUTHTOK) };
        self.call("pam_authenticate", result).map_err(Refusal::Denied)?;
        let result = unsafe { pam_acct_mgmt(self.pamh, PAM_DISALLOW_NULL_AUTHTOK) };
        if result == PAM_NEW_AUTHTOK_REQD {
            self.status = result;
            return Err(Refusal::Expired);
        }
        self.call("pam_acct_mgmt", result).map_err(Refusal::Denied)
    }

    fn user(&self) -> Option<String> {
        let mut item: *const c_void = std::ptr::null();
        let status = unsafe { pam_get_item(self.pamh, PAM_USER, &mut item) };
        if status != PAM_SUCCESS || item.is_null() {
            return None;
        }
        Some(text(item as *const c_char))
    }

    fn open_session(&mut self) -> Result<(), String> {
        let result = unsafe { pam_setcred(self.pamh, PAM_ESTABLISH_CRED) };
        self.call("pam_setcred", result)?;
        self.credentials = true;
        let result = unsafe { pam_open_session(self.pamh, 0) };
        if let Err(e) = self.call("pam_open_session", result) {
            unsafe { pam_setcred(self.pamh, PAM_DELETE_CRED) };
            self.credentials = false;
            return Err(e);
        }
        self.session = true;
        Ok(())
    }

    fn environment(&self) -> Vec<String> {
        let list = unsafe { pam_getenvlist(self.pamh) };
        let mut variables = Vec::new();
        if list.is_null() {
            return variables;
        }
        // the list and its strings are copies for us to free
        let mut i = 0;
        loop {
            let entry = unsafe { *list.add(i) };
            if entry.is_null() {
                break;
            }
            variables.push(text(entry));
            unsafe { libc::free(entry as *mut c_void) };
            i += 1;
        }
        unsafe { libc::free(list as *mut c_void) };
        variables
    }

    fn close_session(&mut self) {
        if self.session {
            self.status = unsafe { pam_close_session(self.pamh, 0) };
            self.session = false;
        }
        if self.credentials {
            unsafe { pam_setcred(self.pamh, PAM_DELETE_CRED) };
            self.credentials = false;
        }
    }

    fn relay(&mut self) -> &mut Relay {
        unsafe { &mut *self.relay }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.pamh.is_null() {
            self.close_session();
        }
        self.end();
        if !self.relay.is_null() {
            drop(unsafe { Box::from_raw(self.relay) });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nebula_login_common::channel::Channel;
    use nebula_login_protocol::{PromptStyle, Record};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    /// The real libpam, without root: an unknown user on the system's fallback service ("other", usually the common
    /// auth stack) is asked for a password through our conversation, and refused. Checks the binding and the
    /// conversation's C side; skipped where the PAM configuration asks nothing.
    #[test]
    fn real_pam_relays_its_prompt_and_refuses_an_unknown_user() {
        let (ours, web) = UnixStream::pair().unwrap();
        let page = std::thread::spawn(move || {
            let mut web = Channel::new(web);
            let mut prompts = Vec::new();
            while let Ok((record, _)) = web.read(Duration::from_secs(10)) {
                if let Record::Prompt { style, text } = &record {
                    prompts.push((*style, text.clone()));
                    if *style == PromptStyle::EchoOff || *style == PromptStyle::EchoOn {
                        web.write(&Record::Answer { text: "not the password".into() }, None).unwrap();
                    }
                }
            }
            prompts
        });
        let relay = Relay::new(Channel::new(ours), Duration::from_secs(10));
        let client: IpAddr = "192.0.2.1".parse().unwrap();
        let mut handle = match Handle::start("nebula-test-nonexistent", "nebula-no-such-user", client, "nebula", relay) {
            Ok(handle) => handle,
            Err((_, e)) => panic!("pam_start failed: {e}"),
        };
        assert!(matches!(handle.authenticate(), Err(Refusal::Denied(_))));
        assert_eq!(handle.user().as_deref(), Some("nebula-no-such-user"));
        drop(handle);
        let prompts = page.join().unwrap();
        eprintln!("PAM asked: {prompts:?}");
        assert!(prompts.iter().all(|(style, text)| *style != PromptStyle::EchoOff || !text.is_empty()));
    }
}
