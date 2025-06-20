import type { OIDCConfig } from '@auth/core/providers';

import { authEnv } from '@/config/auth';

import { CommonProviderConfig } from './sso.config';

// Define a profile type based on expected user data from the internal SSO
// Adjust this based on the actual data structure returned by your SSO's userinfo endpoint
export type InternalSSOProfile = {
  email: string; // Standard OIDC claim
  sub: string; // Standard OIDC claim (subject, used as ID)
  name?: string; // Standard OIDC claim
  preferred_username?: string; // Common OIDC claim, can be used as name
  picture?: string; // Standard OIDC claim
  // Add any other custom claims you expect and want to use
  // e.g., groups?: string[];
};

const providerId = 'internal-sso';
const defaultName = 'Internal SSO';
const defaultScope = 'openid email profile';

const internalSSOProvider = {
  id: providerId,
  provider: {
    ...CommonProviderConfig,
    id: providerId,
    name: process.env.INTERNAL_SSO_NAME || defaultName,
    type: 'oidc',
    // Environment variables will be defined in `src/config/auth.ts`
    // For now, we reference them assuming they will be available via `authEnv` or `process.env`
    // The `?? process.env.AUTH_INTERNAL_SSO_ID` pattern is for the new env variable naming convention
    clientId: authEnv.INTERNAL_SSO_CLIENT_ID ?? process.env.AUTH_INTERNAL_SSO_ID,
    clientSecret: authEnv.INTERNAL_SSO_CLIENT_SECRET ?? process.env.AUTH_INTERNAL_SSO_SECRET,
    issuer: authEnv.INTERNAL_SSO_ISSUER ?? process.env.AUTH_INTERNAL_SSO_ISSUER,

    authorization: {
      params: {
        scope: process.env.INTERNAL_SSO_SCOPE || defaultScope
      }
    },
    checks: ['state', 'pkce'], // Standard OIDC security checks

    profile(profile: InternalSSOProfile) {
      // Map the profile data from the internal SSO to the user object
      // The `id` field in the returned object should be unique for each user
      return {
        id: profile.sub, // Use 'sub' as the unique user ID
        name: profile.name ?? profile.preferred_username ?? profile.email,
        email: profile.email,
        image: profile.picture,
        providerAccountId: profile.sub, // Store the original 'sub' from the provider
      };
    },
  } satisfies OIDCConfig<InternalSSOProfile>,
};

export default internalSSOProvider;
