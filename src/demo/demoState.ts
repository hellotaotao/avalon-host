import { buildRolePreset, type RolePresetOptions } from '../domain/avalon';
import { useI18n } from '../i18n';
import { sanitizeRoleOptions } from '../components/CreateRoomRoleConfig';
import { createAgentMemory } from './demoAi';
import { deterministicShuffle } from './demoRules';
import { type DemoController, type DemoMode, type DemoState } from './demoTypes';

const demoNames = ['Arthur', 'Bors', 'Cai', 'Dagonet', 'Elaine', 'Gareth', 'Helena', 'Isolde', 'Lucan', 'Yvain'];

const aiPersonas = ['Cautious analyst', 'Aggressive accuser', 'Quiet observer', 'Social diplomat', 'Chaotic liar', 'Risk-aware captain', 'Pattern hunter', 'Overconfident knight', 'Skeptical voter'];

export function formatDemoSeatMix(humanCount: number, aiCount: number, t: (text: string) => string, language: ReturnType<typeof useI18n>['language']): string {
  if (language === 'zh') {
    if (aiCount === 0) return `${humanCount} 个手动座位，无 AI 补位`;
    if (humanCount === 0) return `0 个手动座位，观战 ${aiCount} 个 AI 玩家`;
    return `${humanCount} 个手动座位 + ${aiCount} 个 AI 补位`;
  }
  if (aiCount === 0) return `${humanCount} ${t('manual seats')}, ${t('no AI fill-ins')}`;
  if (humanCount === 0) return `${t('Watch')} ${aiCount} ${t('AI players')}`;
  return `${humanCount} ${t('manual seats')} + ${aiCount} ${t('AI fill-ins')}`;
}

export function createDemoState(
  playerCount: number,
  roleOptions: RolePresetOptions,
  options: { humanCount?: number } = {},
): DemoState {
  const sanitizedOptions = sanitizeRoleOptions(playerCount, roleOptions);
  const humanCount = Math.min(Math.max(options.humanCount ?? playerCount, 0), playerCount);
  const mode: DemoMode = humanCount === playerCount ? 'manual' : 'ai';
  const basePlayers = demoNames.slice(0, playerCount).map((name, index) => ({ id: `demo-player-${index + 1}`, name }));
  const presetRoles = buildRolePreset(playerCount, sanitizedOptions).roles;
  const roles = mode === 'ai' ? deterministicShuffle(presetRoles, `ai-table-${playerCount}-${JSON.stringify(sanitizedOptions)}`) : presetRoles;
  const assignedPlayers = basePlayers.map((player, index) => ({ ...player, role: roles[index] }));
  return {
    playerCount,
    roleOptions: sanitizedOptions,
    mode,
    humanCount,
    players: assignedPlayers.map((player, index) => {
      const controller: DemoController = mode === 'ai' && index >= humanCount ? 'ai' : 'human';
      return {
        id: player.id,
        displayName: controller === 'ai' ? `${player.name} AI` : player.name,
        seatIndex: index,
        role: player.role ?? 'Loyal Servant',
        controller,
        persona: controller === 'ai' ? aiPersonas[(index - humanCount + aiPersonas.length) % aiPersonas.length] : undefined,
        memory: controller === 'ai' ? createAgentMemory(basePlayers.map((candidate) => candidate.id), player.id) : undefined,
      };
    }),
    phase: 'setup',
    roundIndex: 0,
    leaderIndex: 0,
    proposalIndex: 0,
    selectedTeamIds: [],
    missionResults: [],
    tableHistory: [],
    aiHistory: [],
  };
}
