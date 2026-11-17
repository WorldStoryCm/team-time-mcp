import { TeamTimeClient, TeamTimeError } from './api.mjs';
export async function configuredClient(env = process.env) {
  const mode = env.TEAM_TIME_MODE || 'auto';
  if (!['auto', 'local', 'cloud'].includes(mode))
    throw new TeamTimeError(
      'configuration',
      'TEAM_TIME_MODE must be auto, local or cloud.'
    );
  const cloud =
    mode === 'cloud' ||
    (mode === 'auto' &&
      [
        env.TEAM_TIME_API_KEY,
        env.TEAM_TIME_ORGANIZATION_ID,
        env.TEAM_TIME_ORIGIN
      ].some(Boolean));
  if (cloud)
    return new TeamTimeClient({
      apiKey: env.TEAM_TIME_API_KEY,
      organizationId: env.TEAM_TIME_ORGANIZATION_ID,
      origin: env.TEAM_TIME_ORIGIN,
      stateDirectory: env.TEAM_TIME_STATE_DIR
    });
  const { LocalClient } = await import('./local.mjs');
  return new LocalClient(env);
}
