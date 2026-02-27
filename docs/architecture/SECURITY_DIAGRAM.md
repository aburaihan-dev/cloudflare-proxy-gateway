# Security Layers Diagram

This diagram explains how the different security checks protect your API.

```
                               Incoming Request
                                      │
                                      ▼
                        [ 1. Blocklist Check ]  <-- (New!)
                        │ Is the caller in the "blockedOrigins" list?
                        │ (Checks Origin, Referer, cf-worker headers)
                        │
             YES ───────┼──────────────────────────┐
             │                                     │
             ▼                                     ▼
        🛑 BLOCKED (403)                     [ 2. Shared Secret Check ] <-- (Temporary Solution)
        "Access blocked"                     │ Is "requiredHeaders" configured?
                                             │
                                   YES ──────┼────────────── NO ──┐
                                   │         │                    │
                                   ▼         │                    │
                        [ Does Request have  ]                    │
                        [ X-Client-Secret?   ]                    │
                                   │                              │
                        NO ────────┼──────── YES                  │
                        │          │                              │
                        ▼          ▼                              ▼
                   🛑 BLOCKED    [ 3. Origin Whitelist Check ]    │
                   "Invalid"     │ Is "allowedOrigins" configured?│
                                 │                                │
                       YES ──────┼────────────── NO ──┐           │
                       │         │                    │           │
                       ▼         │                    │           │
            [ Does Origin match  ]                    │           │
            [ the allowed list?  ]                    │           │
                       │                              │           │
             NO ───────┼─────── YES                   │           │
             │         │                              │           │
             ▼         ▼                              ▼           ▼
        🛑 BLOCKED   ✅ ALLOWED                   ✅ ALLOWED   ✅ ALLOWED
        "Forbidden"
```

## How it protects you:

1.  **Blocklist (The Bouncer)**:
    *   **Goal**: Stop known bad guys immediately.
    *   **Action**: If the request comes from `dhaka18-site.pages.dev`, it is stopped at step 1. They don't get any further.

2.  **Shared Secret (The Password)**:
    *   **Goal**: Ensure only *your* frontend app is calling the API.
    *   **Action**: Even if a hacker pretends to be "your-website.com" (spoofing Origin), they won't know the secret password (`X-Client-Secret`). Without it, they get blocked at step 2.

3.  **Origin Whitelist (The ID Check)**:
    *   **Goal**: Stop random websites from using your API in *their* browser apps.
    *   **Action**: If a random site tries to call your API from a user's browser, the browser sends *their* Origin. Since it doesn't match your list, they are blocked at step 3.
