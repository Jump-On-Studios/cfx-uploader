# CFX Authentication Exploration

Exploration date: 2026-07-21

Last update: 2026-07-22 (headless workflow implemented; real end-to-end validation still pending)

Status: the password, new-device email verification, both 2FA DOM variants, persistent Chromium profile, normalized headless fingerprint, direct Portal API validation, and one-shot Portal SSO fallback are implemented. A clean real-world headless run and cache reuse still need to be validated end to end. Negative-code and paste-behavior exploration remains pending.

## Scope

- Explore the CFX Portal entry point and the Cfx Forum login flow.
- Capture stable accessibility labels, transitions, visible states, and error messages.
- Identify the handoff needed by the existing Puppeteer authentication code.
- Never record usernames, passwords, 2FA codes, cookies, tokens, or other credential values.

## Synthese de la session de diagnostic

### Objectif et contrainte principale

L'objectif est de rendre l'authentification CFX entierement utilisable sur un VPS Linux sans interface graphique. Generer une session en mode visible sur le poste Windows puis copier ou reutiliser cette session n'est pas considere comme une solution perenne. Le parcours complet doit fonctionner avec Chromium headless, profil vierge et cache vierge.

Le parcours reel confirme est :

```text
Portal CFX
-> Sign in with
-> login Forum par identifiant et mot de passe
-> challenge nouvel appareil ou nouvelle localisation
-> lien de connexion recu par email
-> ouverture du lien dans le meme navigateur et le meme profil
-> ecran 2FA specifique au lien email
-> saisie des six chiffres
-> clic explicite sur Finish Login
-> retour sur https://forum.cfx.re/ en etat connecte
-> creation et validation d'une session HTTP Portal API
-> handoff SSO Portal unique seulement si necessaire
-> sauvegarde du cache chiffre apres validation API
```

### Hypothese initiale : empreinte Chromium headless

La difference observee entre `headless:false` et `headless:true` intervient pendant l'authentification navigateur, avant tout upload. Elle ne peut donc pas etre expliquee par les headers HTTP de l'upload CFX.

L'hypothese principale est une difference d'empreinte Chromium : User-Agent, Client Hints, dimensions, ecran virtuel, plateforme, `navigator.webdriver` ou autres signaux d'automatisation. CFX peut interpreter le navigateur headless comme un nouvel appareil et demander une validation email.

Les adaptations retenues sont :

- un `browserProfilePath` transmis a Puppeteer comme `userDataDir` afin de conserver l'identite navigateur ;
- une empreinte `native` par defaut dans la bibliotheque ;
- une empreinte `normalized` activee explicitement par le bot ;
- un User-Agent sans marqueur `HeadlessChrome`, des Client Hints coherents, un viewport `1280x800`, un ecran `1920x1080` et `navigator.webdriver === false` ;
- des logs limites aux proprietes non sensibles de l'empreinte.

Cette normalisation ne supprime pas necessairement le challenge nouvel appareil. Elle vise surtout a rendre l'identite headless coherente et stable d'une execution a l'autre. Le profil persistant reste indispensable sur le VPS.

### Rate-limit CFX rencontre

Apres plusieurs essais rapproches, CFX a affiche :

```text
Please wait before trying to log in again.
```

Ce message est un rate-limit de connexion, pas un timeout 2FA et pas une erreur d'upload. Relancer immediatement les essais ne fait qu'entretenir le blocage. Le code detecte maintenant cet etat et leve `CFX_LOGIN_RATE_LIMITED` sans demander de lien email, sans demander de code 2FA et sans effectuer de retry.

La bonne conduite est d'arreter le workflow, d'attendre le cooldown, puis d'effectuer une seule nouvelle tentative avec un nouveau lien email.

### Premier blocage apres ouverture du lien email

Le lien email etait bien ouvert par `page.goto()` dans le navigateur d'authentification courant, mais le workflow attendait uniquement :

```css
#login-second-factor
```

Ce selecteur appartient au 2FA classique integre a `/login`. La page `/session/email-login/<token>` utilise un DOM different. L'automatisation restait donc en attente alors que l'ecran 2FA etait deja affiche.

Le diagnostic assaini a notamment montre une premiere lecture vide :

```text
title: Cfx Forum
headings: []
inputs: []
buttons: []
```

Cette lecture intermediaire correspond a l'hydratation de la page et ne doit pas etre consideree immediatement comme un echec. Apres attente, la page a ete reconnue. La detection accepte maintenant les deux variantes visibles :

```css
#login-second-factor
input[data-slot="input-otp"]
input.second-factor-token-input[autocomplete="one-time-code"][maxlength="6"]
```

Les diagnostics ne contiennent que l'URL assainie, l'origine, le chemin, le titre, les headings, les metadonnees des inputs et les libelles des boutons. Ils n'incluent jamais les valeurs, tokens, cookies, mots de passe ou codes 2FA.

### Deuxieme blocage : soumission du 2FA email

La capture et le DOM ont confirme que les six cases visibles sont decoratives. Le code complet doit etre saisi dans un seul input composite `input[data-slot="input-otp"]`.

Contrairement au 2FA classique, remplir les six chiffres ne soumet pas automatiquement le formulaire de la page email. Il faut cliquer explicitement sur le bouton `Finish Login` du formulaire proprietaire.

Le helper de soumission :

- valide exactement six chiffres ;
- resout uniquement un input visible ;
- prepare l'attente de transition avant la saisie ;
- laisse une courte fenetre a une eventuelle variante auto-submit ;
- clique une seule fois sur `Log In` pour la variante classique encore visible ;
- clique une seule fois sur `Finish Login` pour la variante email encore visible ;
- tolere une destruction du contexte JavaScript pendant la navigation ;
- ne reutilise jamais un code apres une erreur et ne double-clique jamais.

### Troisieme blocage : confusion entre succes Forum et succes Portal

Apres `Finish Login`, le comportement reel observe est un retour vers :

```text
https://forum.cfx.re/
```

Le Forum est alors connecte. Une premiere implementation a poursuivi immediatement vers `https://portal.cfx.re/assets/created-assets` et a termine par :

```text
Portal failed to load after password authentication.
```

Le probleme etait un melange de trois responsabilites distinctes :

1. authentifier le navigateur sur le Forum ;
2. construire une session HTTP utilisable par `portal-api.cfx.re` ;
3. ouvrir visuellement `Created Assets` pour les workflows pilotes par navigateur.

Le retour authentifie sur le Forum termine maintenant la premiere responsabilite. Pour le workflow HTTP et `checkAuthentication()`, le critere final est une requete reussie vers :

```text
GET /v1/me/assets
```

Le code recupere uniquement les cookies applicables a `portal.cfx.re` et `portal-api.cfx.re`. Les cookies host-only du Forum ne sont jamais envoyes artificiellement a l'API.

Le comportement final est :

1. tenter directement de construire et valider la session API apres l'authentification Forum ;
2. si l'API repond avec succes, sauvegarder le cache chiffre et fermer Chromium ;
3. si aucun cookie Portal/API n'existe, ou si l'API repond `401`/`403`, effectuer exactement un handoff SSO Portal ;
4. recuperer de nouveau les cookies et revalider l'API ;
5. ne sauvegarder le cache qu'apres une validation reussie ;
6. ne pas effectuer de handoff pour une erreur reseau ou une reponse serveur `5xx` ;
7. echouer sans cache si la seconde validation retourne encore `401`/`403`.

Le workflow `uploadBrowser` reste volontairement different : comme il pilote l'interface du Portal, il doit atteindre la page `Created Assets`. Le workflow HTTP et `checkAuthentication()` n'ont pas besoin de cette page lorsque la session API est deja valide.

### Profil, cache et interruption par Ctrl+C

Deux persistances sont utilisees et ne doivent pas etre confondues :

| Etat | Role | Exemple de variable |
|---|---|---|
| Profil Chromium | Identite navigateur, cookies et reconnaissance de l'appareil | `CFX_UPLOADER_BROWSER_PROFILE_PATH` |
| Cache chiffre | Session HTTP deja validee pour Portal API | `CFX_UPLOADER_SESSION_CACHE_PATH` |

Une interruption de `auth-check` par `Ctrl+C` a laisse le fichier de verrou du cache :

```text
<session-cache-path>.lock
```

L'execution suivante semblait ne rien faire et n'affichait aucune erreur, car elle attendait ce verrou avant meme de lancer Chromium et d'afficher l'empreinte. Un smoke test Puppeteer avec un profil temporaire a confirme que Chromium demarrait normalement ; le blocage ne venait donc pas du navigateur.

Le bot fournit maintenant deux commandes :

```powershell
# Cache et verrou uniquement
npm run cfx:clear-session

# Cache, verrou et profil Chromium
npm run cfx:clear-auth
```

Il faut arreter le bot et tous les processus `auth-check` avant le nettoyage. `cfx:clear-auth` protege contre les chemins dangereux et refuse notamment une racine de disque, le repertoire personnel et le workspace courant.

### CLI de diagnostic et mode visible

La commande de diagnostic n'effectue aucun upload :

```powershell
npm run auth-check
```

Elle utilise Chromium headless par defaut, demande le lien email complet puis le code 2FA dans le terminal, valide la session API et retourne un resultat de la forme :

```text
CFX authentication valid: method=password sessionReused=false
```

Une relance avec un cache encore valide doit retourner :

```text
CFX authentication valid: method=cached sessionReused=true
```

Le mode visible reste disponible pour observer et comparer le parcours localement :

```powershell
npm run auth-check -- --show-browser
```

ou :

```powershell
npm run auth-check -- --headless=false
```

La variable `CFX_UPLOADER_HEADLESS=false` n'est pas lue par cette CLI ; il faut utiliser l'un de ces arguments. Le mode visible est un outil de diagnostic, pas la solution de production.

Pendant le developpement, `jo_discord_bot/node_modules/cfx-uploader` est relie au depot local `cfx-autoupload` avec `npm link`. Les corrections de la bibliotheque sont donc testables depuis le bot sans publication immediate du package.

### Configuration cible

Configuration locale ou VPS attendue :

```env
CFX_UPLOADER_HEADLESS=true
CFX_UPLOADER_HEADLESS_FINGERPRINT=normalized
CFX_UPLOADER_BROWSER_PROFILE_PATH=/var/lib/jo-discord-bot/cfx-browser-profile
CFX_UPLOADER_SESSION_CACHE_PATH=/var/lib/jo-discord-bot/cfx-session.enc
CFX_UPLOADER_EMAIL_VERIFICATION_TIMEOUT_MS=600000
CFX_UPLOADER_2FA_TIMEOUT_MS=600000
```

Sur le VPS, le repertoire du profil doit avoir les permissions `0700`, appartenir a l'utilisateur PM2 et n'etre utilise que par une seule instance du bot. L'IP de sortie doit rester aussi stable que possible.

### Etat des tests et prochaine recette

Les suites automatisees couvrent notamment :

- la persistance du profil via `userDataDir` ;
- les empreintes `native` et `normalized` ;
- la validation stricte et assainie du lien email ;
- les deux variantes DOM du 2FA ;
- l'auto-submit et la soumission manuelle sans double clic ;
- la detection immediate du rate-limit ;
- la validation API directe et le handoff SSO unique ;
- l'absence de cache apres un echec d'authentification ;
- l'absence de secrets dans les logs et erreurs ;
- le broker Discord lien email puis code 2FA ;
- le nettoyage du cache, de son verrou et du profil.

Au dernier point de controle de cette session, la bibliotheque `cfx-uploader` avait 46 tests passants et le bot 19 tests passants. Cela valide la logique simulee, pas le comportement reel de CFX.

La recette de reference restante est :

1. attendre la fin de tout rate-limit CFX ;
2. arreter le bot et tout ancien `auth-check` ;
3. executer `npm run cfx:clear-auth` ;
4. lancer `npm run auth-check` en headless ;
5. fournir un nouveau lien email non expose et non consomme ;
6. fournir le code 2FA courant ;
7. verifier le clic unique sur `Finish Login` et le retour Forum ;
8. verifier la validation directe de Portal API ou, seulement si necessaire, un handoff SSO unique ;
9. obtenir `sessionReused=false` et verifier la creation du profil et du cache ;
10. relancer sans nettoyage et obtenir `sessionReused=true` sans Chromium ni nouveau 2FA ;
11. redemarrer la machine et confirmer la reutilisation ;
12. deplacer temporairement uniquement le cache, conserver le profil, puis confirmer la reconnaissance du navigateur ;
13. reproduire enfin le meme parcours sur le VPS Linux sans aucun passage en mode visible.

Tous les liens email et codes 2FA communiques pendant l'exploration sont consideres exposes, expires ou consommes et ne doivent jamais etre reutilises.

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

This completes the Forum authentication state. For the HTTP workflow, automation first extracts cookies applicable to `portal.cfx.re` and `portal-api.cfx.re` and validates them through `GET /v1/me/assets`. A successful API response allows the encrypted session cache to be written without another browser navigation. Missing applicable cookies or a `401`/`403` triggers at most one `Sign in with` handoff before the API validation is repeated.

The browser-upload workflow remains different: because it controls the Portal UI, it still navigates to `https://portal.cfx.re/assets/created-assets` and requires `Created Assets` to be visible before continuing.

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
