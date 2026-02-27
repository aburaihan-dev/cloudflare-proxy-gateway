/**
 * Auth Adapter Registration
 *
 * This is the ONLY file you need to edit to add custom auth adapters.
 * Built-in adapters are registered below — add your own underneath.
 *
 * To create a custom adapter:
 *   1. Create src/auth/adapters/my-adapter.ts implementing the AuthAdapter interface
 *   2. Import and register it here
 *   3. Reference it in config.json: { "adapter": "my-adapter", ...config }
 *
 * See src/auth/adapters/supabase.ts for a complete example.
 */
import { registerAdapter } from '../registry';
import { forwardAuthAdapter } from './forward-auth';
import { jwtAdapter } from './jwt';

// ── Built-in adapters ────────────────────────────────────────────────────────
registerAdapter(forwardAuthAdapter);
registerAdapter(jwtAdapter);

// ── Custom adapters ──────────────────────────────────────────────────────────
// Uncomment and configure to enable:

// import { supabaseAdapter } from './supabase';
// registerAdapter(supabaseAdapter);

// import { myAdapter } from './my-adapter';
// registerAdapter(myAdapter);
