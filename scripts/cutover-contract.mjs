const CUTOVER_COMMAND_REQUIREMENTS = Object.freeze([
  Object.freeze({ capability: "competition", command: "competition.round.prepare" }),
  Object.freeze({ capability: "voting", command: "voting.ballot.submit" }),
  Object.freeze({ capability: "publishing", command: "publishing.result.release" }),
]);

export function missingCutoverCommandScopes(enabledCapabilities, commandScopes) {
  const enabled = new Set(enabledCapabilities);
  return CUTOVER_COMMAND_REQUIREMENTS
    .filter(({ capability, command }) => {
      if (!enabled.has(capability)) return false;
      const scopes = commandScopes[command];
      return !Array.isArray(scopes) || scopes.length === 0;
    })
    .map(({ command }) => command);
}
