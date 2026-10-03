// Privileged PAM helper for the Greenfield gateway. Runs as root, does as little as possible.
//
//   pam-helper auth <username>
//     Reads the password from stdin (never argv). Runs pam_authenticate + pam_acct_mgmt.
//     On success prints "<uid> <gid> <home>\n" for the canonical user and exits 0. On any failure exits 1 and
//     prints nothing, so an unknown user and a wrong password look the same.
//
//   pam-helper session <username> -- <command> [args...]
//     Opens a PAM session for the user (pam_systemd registers it with logind when configured, which sets up
//     XDG_RUNTIME_DIR and the user's D-Bus bus), then forks: the child drops to the user (initgroups/setgid/setuid),
//     changes to the home directory and execs the command with the PAM environment merged into the inherited one.
//     The parent stays root, forwards SIGTERM/SIGINT/SIGHUP to the child, waits for it and closes the PAM session.
//     Authentication must already have happened (via `auth`); this mode does not ask for a password.
//
// The PAM service name is "greenfield" (see ../pam/greenfield).

#define _GNU_SOURCE
#include <errno.h>
#include <grp.h>
#include <pwd.h>
#include <security/pam_appl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define SERVICE "greenfield"
#define MAX_PASSWORD 1024

static char password[MAX_PASSWORD + 1];

static int conversation(int num_msg, const struct pam_message **msg, struct pam_response **resp, void *appdata) {
    (void) appdata;
    if (num_msg <= 0 || num_msg > PAM_MAX_NUM_MSG) {
        return PAM_CONV_ERR;
    }
    struct pam_response *replies = calloc((size_t) num_msg, sizeof(*replies));
    if (replies == NULL) {
        return PAM_BUF_ERR;
    }
    for (int i = 0; i < num_msg; i++) {
        switch (msg[i]->msg_style) {
            case PAM_PROMPT_ECHO_OFF:
                // the only secret we have is the password; answer every hidden prompt with it
                replies[i].resp = strdup(password);
                if (replies[i].resp == NULL) {
                    goto fail;
                }
                break;
            case PAM_PROMPT_ECHO_ON:
                // e.g. a second factor or username prompt; not supported
                goto fail;
            case PAM_ERROR_MSG:
            case PAM_TEXT_INFO:
                break;
            default:
                goto fail;
        }
    }
    *resp = replies;
    return PAM_SUCCESS;

fail:
    for (int i = 0; i < num_msg; i++) {
        if (replies[i].resp != NULL) {
            explicit_bzero(replies[i].resp, strlen(replies[i].resp));
            free(replies[i].resp);
        }
    }
    free(replies);
    return PAM_CONV_ERR;
}

static int valid_username(const char *name) {
    size_t len = strlen(name);
    if (len == 0 || len > 64) {
        return 0;
    }
    for (size_t i = 0; i < len; i++) {
        char c = name[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' ||
              c == '.' || (c == '$' && i == len - 1))) {
            return 0;
        }
    }
    return name[0] != '-';
}

static int read_password(void) {
    size_t total = 0;
    while (total < MAX_PASSWORD) {
        ssize_t n = read(STDIN_FILENO, password + total, MAX_PASSWORD - total);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            return -1;
        }
        if (n == 0) {
            break;
        }
        total += (size_t) n;
    }
    password[total] = '\0';
    return 0;
}

static int do_auth(const char *username) {
    if (read_password() != 0) {
        return 1;
    }
    struct pam_conv conv = {conversation, NULL};
    pam_handle_t *pamh = NULL;
    int result = pam_start(SERVICE, username, &conv, &pamh);
    if (result == PAM_SUCCESS) {
        result = pam_authenticate(pamh, PAM_DISALLOW_NULL_AUTHTOK);
    }
    if (result == PAM_SUCCESS) {
        result = pam_acct_mgmt(pamh, PAM_DISALLOW_NULL_AUTHTOK);
    }
    // PAM may have mapped the login name to the canonical one
    const void *canonical = NULL;
    if (result == PAM_SUCCESS) {
        result = pam_get_item(pamh, PAM_USER, &canonical);
    }
    struct passwd *pw = NULL;
    if (result == PAM_SUCCESS && canonical != NULL) {
        pw = getpwnam((const char *) canonical);
    }
    explicit_bzero(password, sizeof(password));
    if (pamh != NULL) {
        pam_end(pamh, result);
    }
    if (result != PAM_SUCCESS || pw == NULL) {
        return 1;
    }
    printf("%u %u %s\n", (unsigned) pw->pw_uid, (unsigned) pw->pw_gid, pw->pw_dir);
    return 0;
}

static volatile pid_t child_pid = 0;

static void forward_signal(int sig) {
    if (child_pid > 0) {
        kill(child_pid, sig);
    }
}

static int do_session(const char *username, char **command) {
    struct passwd *pw = getpwnam(username);
    if (pw == NULL) {
        fprintf(stderr, "pam-helper: unknown user\n");
        return 1;
    }
    // copy what we need, getpwnam's buffer may be reused by PAM modules
    uid_t uid = pw->pw_uid;
    gid_t gid = pw->pw_gid;
    char *home = strdup(pw->pw_dir);
    char *shell = strdup(pw->pw_shell);
    char *name = strdup(pw->pw_name);
    if (home == NULL || shell == NULL || name == NULL) {
        return 1;
    }
    if (uid == 0) {
        fprintf(stderr, "pam-helper: refusing to start a session for root\n");
        return 1;
    }

    struct pam_conv conv = {conversation, NULL};
    pam_handle_t *pamh = NULL;
    int result = pam_start(SERVICE, name, &conv, &pamh);
    if (result != PAM_SUCCESS) {
        fprintf(stderr, "pam-helper: pam_start: %s\n", pam_strerror(pamh, result));
        return 1;
    }
    // read by pam_systemd when it registers the session with logind
    pam_putenv(pamh, "XDG_SESSION_TYPE=wayland");
    pam_putenv(pamh, "XDG_SESSION_CLASS=user");
    pam_putenv(pamh, "XDG_SESSION_DESKTOP=greenfield");

    result = pam_acct_mgmt(pamh, 0);
    if (result == PAM_SUCCESS) {
        result = pam_setcred(pamh, PAM_ESTABLISH_CRED);
    }
    int session_opened = 0;
    if (result == PAM_SUCCESS) {
        result = pam_open_session(pamh, 0);
        session_opened = result == PAM_SUCCESS;
    }
    if (result != PAM_SUCCESS) {
        fprintf(stderr, "pam-helper: opening session failed: %s\n", pam_strerror(pamh, result));
        pam_setcred(pamh, PAM_DELETE_CRED);
        pam_end(pamh, result);
        return 1;
    }

    pid_t pid = fork();
    if (pid < 0) {
        perror("pam-helper: fork");
        result = PAM_SYSTEM_ERR;
        goto close;
    }
    if (pid == 0) {
        char **pam_env = pam_getenvlist(pamh);
        if (pam_env != NULL) {
            for (char **e = pam_env; *e != NULL; e++) {
                putenv(*e);
            }
        }
        setenv("HOME", home, 1);
        setenv("USER", name, 1);
        setenv("LOGNAME", name, 1);
        setenv("SHELL", shell, 1);
        if (initgroups(name, gid) != 0 || setgid(gid) != 0 || setuid(uid) != 0) {
            perror("pam-helper: dropping privileges");
            _exit(126);
        }
        // never continue with privileges we were supposed to drop
        if (setuid(0) == 0 || geteuid() != uid || getegid() != gid) {
            fprintf(stderr, "pam-helper: privileges were not dropped\n");
            _exit(126);
        }
        if (chdir(home) != 0 && chdir("/") != 0) {
            _exit(126);
        }
        execvp(command[0], command);
        perror("pam-helper: exec");
        _exit(127);
    }

    child_pid = pid;
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = forward_signal;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGHUP, &sa, NULL);

    int status = 0;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR) {
            break;
        }
    }

close:
    if (session_opened) {
        pam_close_session(pamh, 0);
    }
    pam_setcred(pamh, PAM_DELETE_CRED);
    pam_end(pamh, result);
    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    }
    return 1;
}

int main(int argc, char **argv) {
    if (argc >= 3 && strcmp(argv[1], "auth") == 0 && argc == 3) {
        if (!valid_username(argv[2])) {
            return 1;
        }
        return do_auth(argv[2]);
    }
    if (argc >= 5 && strcmp(argv[1], "session") == 0 && strcmp(argv[3], "--") == 0) {
        if (!valid_username(argv[2])) {
            return 1;
        }
        return do_session(argv[2], &argv[4]);
    }
    fprintf(stderr, "usage: pam-helper auth <user> | pam-helper session <user> -- <command> [args...]\n");
    return 2;
}
