# CFX Authentication Exploration

Exploration date: 2026-07-21

Last update: 2026-07-22 (2FA screen reached through an email login link)

Status: complete for the nominal username/password + 2FA flow and for DOM identification of the email-link + 2FA flow. Headless execution of the latter still needs to be validated end to end. Negative-code and paste-behavior exploration remains pending.

## Scope

- Explore the CFX Portal entry point and the Cfx Forum login flow.
- Capture stable accessibility labels, transitions, visible states, and error messages.
- Identify the handoff needed by the existing Puppeteer authentication code.
- Never record usernames, passwords, 2FA codes, cookies, tokens, or other credential values.

## Portal Login Entry Point

URL:

```text
https://portal.cfx.re/login
```

Observed page:

- Title: `Login - Cfx.re Portal`
- Heading: `Welcome back!`
- Button: `Sign in with`
- The button redirects to the Cfx Forum login flow.

The private browser session initially displayed a cookie information banner. Its visible controls included `Autoriser tous les cookies`, `Tout refuser`, `Paramètres des cookies`, and `Fermer`. After dismissing it and taking a fresh DOM snapshot, the banner was no longer present.

## Forum Login Page

URL after clicking the portal sign-in button:

```text
https://forum.cfx.re/login
```

Observed title:

```text
Cfx Forum - The home of FiveM & RedM
```

Observed accessible controls:

```text
heading "Welcome back"
textbox "Email / Username"
textbox "Password"
link "I forgot my password"
button "Log In"
button "Sign in with Google"
button "Log in with Patreon"
button "Log in with a passkey"
button "Sign Up"
```

Visible form input metadata:

| Purpose | Selector | Type | Autocomplete | Form |
|---|---|---|---|---|
| Account identifier | `#login-account-name` | `email` | `username webauthn` | `#login-form` |
| Password | `#login-account-password` | `password` | `current-password` | `#login-form` |

The page also contains a hidden legacy form with `#signin_username`, `#signin_password`, and `#signin-button`. It must not be used by automation. The visible `#login-form` fields and their accessible names are the reliable targets observed so far.

After an identifier is entered, an additional link appears:

```text
Skip the password; email me a login link
```

The password field is a password input and exposes a `Show password` button after it has been filled. Automation must inspect input metadata and accessibility state without reading the field value.

## First Submission Attempt

The test credentials were read from the explicitly authorized local environment variables and submitted to the Cfx Forum login form. No credential value is recorded here.

Immediately after submission, the page remained at `/login` and displayed:

```text
Please wait before trying to log in again.
```

The 2FA screen was not reached during this attempt. This may indicate CFX throttling, a transient login state, or a rejected/too-rapid submission. It must be rechecked after the cooldown rather than retried in a tight loop.

After waiting and re-attaching to the private tab, the throttling message was no longer visible and the login form was available again. This confirms that the message is a transient state rather than a permanent navigation error.

## Pending Exploration

- Determine the exact cooldown behavior and whether the message clears automatically.
- Test paste behavior, non-digit input handling, invalid six-digit codes, expiration, and retry behavior.
- Test cache invalidation after server-side session revocation.

The nominal flow is implemented by `src/auth/cfx-auth.js` for the HTTP/library path and was validated through the HTTP CLI. The browser CLI intentionally remains passkey-focused.

## Two-Factor Authentication After Direct Password Submission

After the second login attempt, CFX transitioned to the 2FA state without displaying the throttling message.

Observed accessible content:

```text
heading "Welcome back"
heading "Two-Factor Authentication"
paragraph "Please enter the authentication code from your app:"
textbox "Enter 6 numbers"
button "Log In"
```

The visual/a11y structure shows six digit positions, but the DOM uses one visible composite input:

| Purpose | Selector | Type | Autocomplete | Max length |
|---|---|---|---|---:|
| 2FA code | `#login-second-factor` | `text` | `one-time-code` | `6` |

The account and password inputs remain in the DOM but become hidden. The automation should target `#login-second-factor` or the accessible name `Enter 6 numbers`, not six positional inputs.

Still pending: whether the field accepts a pasted six-digit value, whether non-digits are rejected client-side, and the exact error behavior after submitting an invalid or expired code.

## Two-Factor Authentication After An Email Login Link

Exploration date: 2026-07-22

Evidence: a screenshot and a browser DOM capture taken after opening a valid email login link in a visible browser. The credential-bearing token is intentionally omitted from this document.

Sanitized route:

```text
https://forum.cfx.re/session/email-login/<REDACTED_32_HEX_TOKEN>
```

Visible content:

```text
heading "Two-Factor Authentication"
paragraph "Please enter the authentication code from your app:"
textbox "Enter 6 numbers"
button "Finish Login"
```

Important observed behavior: entering all six digits does **not** submit this page automatically. The user must manually click `Finish Login`. Headless automation must reproduce that explicit click exactly once after filling the OTP input.

This is not the same DOM as the 2FA state displayed inside the regular `/login` form. In particular, `#login-second-factor` does not exist on this page. Waiting exclusively for that selector therefore causes the headless workflow to remain blocked until its authentication timeout, even though navigation to the email link succeeded and the 2FA page is already visible.

The relevant sanitized DOM structure is:

```html
<div class="container email-login clearfix">
  <form>
    <div class="email-login-form">
      <div id="second-factor">
        <h3>Two-Factor Authentication</h3>
        <p class="second-factor__description">
          Please enter the authentication code from your app:
        </p>

        <div class="d-otp">
          <div class="d-otp-group">
            <!-- Six visual slots; these are div elements, not inputs. -->
          </div>
          <div class="d-otp-input-wrapper">
            <input
              inputmode="numeric"
              autocomplete="one-time-code"
              data-slot="input-otp"
              class="d-otp-input second-factor-token-input"
              maxlength="6"
              aria-label="Enter 6 numbers"
            >
          </div>
        </div>
      </div>

      <button class="btn btn-primary" type="submit">
        <span class="d-button-label">Finish Login</span>
      </button>
    </div>
  </form>
</div>
```

Observed input metadata:

| Purpose | Preferred selector | Supporting attributes | Max length |
|---|---|---|---:|
| Email-link 2FA code | `input[data-slot="input-otp"]` | `inputmode="numeric"`, `autocomplete="one-time-code"`, `aria-label="Enter 6 numbers"` | `6` |

Useful state and submission selectors:

| Purpose | Selector or condition |
|---|---|
| 2FA state container | `#second-factor` |
| Composite OTP input | `input[data-slot="input-otp"]` |
| Defensive OTP fallback | `input.second-factor-token-input[autocomplete="one-time-code"][maxlength="6"]` |
| Owning form | `input[data-slot="input-otp"]` followed through `closest("form")` |
| Submit control | The owning form's visible `button[type="submit"]`, whose observed label is `Finish Login` |

The six boxes visible in the screenshot are presentation-only `.d-otp-slot` elements. Automation must type the complete six-digit code into the single composite input rather than trying to address six individual fields.

For this email-link variant, filling all six digits does not submit the form automatically in the observed workflow. Automation must explicitly submit the owning form once, preferably by clicking its visible `button[type="submit"]` after preparing the navigation/state-transition wait. It must still guard against a future auto-submit variant so that it never submits twice.

After `Finish Login` is submitted successfully, the observed destination is the authenticated forum home page:

```text
https://forum.cfx.re/
```

This is an intermediate success state, not the final Portal authentication result. Automation must then navigate explicitly to `https://portal.cfx.re/assets/created-assets`, perform at most one `Sign in with` handoff if Portal redirects to `/login`, and accept the workflow only after `Created Assets` becomes visible.

### Headless implementation consequence

Immediately after `page.goto(emailLoginLink)` completes, authentication state detection should accept either of these visible inputs:

```text
#login-second-factor
input[data-slot="input-otp"]
```

The first selector represents the regular login-page 2FA variant; the second represents the email-login route captured here. The code-entry and submit routine should resolve the visible input first, then locate the submit button inside that input's own form. This avoids coupling submission to page-wide button text and prevents accidentally clicking an unrelated control.

If neither selector appears, safe diagnostics may record the sanitized URL, document title, headings, input metadata, and button labels. They must never record the email-link token, input values, cookies, password, or 2FA code.

## Successful Authentication And SSO Handoff

The six-digit value was entered into `#login-second-factor`. The field submitted the form automatically as soon as the sixth digit was present; there was no need to click the visible `Log In` button.

Observed transition after the 2FA submission:

1. The page returned to `https://portal.cfx.re/login`.
2. The forum session was authenticated, but the portal still displayed its `Sign in with` entry point.
3. Navigating directly to `/assets/created-assets` still redirected to `/login?return=%252Fassets%252Fcreated-assets`.
4. Clicking the portal `Sign in with` button a second time completed the SSO handoff.
5. The final authenticated URL was:

```text
https://portal.cfx.re/assets/created-assets?page=1&sort=asset.id&direction=desc
```

Final visible signal:

```text
Created Assets
```

Implementation implication: the password/2FA strategy must allow for a post-2FA return to the portal login entry point and retry the portal SSO handoff once. It should wait on the final `Created Assets` state rather than assuming that the first redirect after the 2FA submission is already authenticated for the Portal API.

## Selector Guidance

Prefer the observed accessible names, semantic attributes, and roles above. Avoid hashed CSS classes and positional selectors. The implementation should wait for visible page states and explicit messages instead of relying on fixed delays.

The two confirmed 2FA variants must remain distinct:

| Entry path | 2FA input | Submit label | Submission behavior observed |
|---|---|---|---|
| Direct password login | `#login-second-factor` | `Log In` | Auto-submit after the sixth digit was observed |
| Email login link | `input[data-slot="input-otp"]` | `Finish Login` | Explicit form submission is required |
