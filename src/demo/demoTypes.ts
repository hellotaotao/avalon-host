import { type Allegiance, type MissionCard, type Role, type RolePresetOptions, type Vote } from '../domain/avalon';
import { type AiAvalonDecision, type AiAgentMemory, type AiBeliefAudit } from '../aiAvalon';

export type DemoController = 'human' | 'ai';

export type DemoMode = 'manual' | 'ai';

export type AgentMemory = AiAgentMemory;

export interface DemoPlayer {
  id: string;
  displayName: string;
  seatIndex: number;
  role: Role;
  controller: DemoController;
  persona?: string;
  memory?: AgentMemory;
  lastReasoningSummary?: string;
  lastPublicSpeech?: string;
  teamVote?: Vote;
  missionCard?: MissionCard;
}

export interface DemoMissionResult {
  roundIndex: number;
  outcome: 'success' | 'fail';
  successCount: number;
  failCount: number;
  requiredFails: number;
  selectedTeamIds?: string[];
}

export interface DemoHistoryEntry {
  id: string;
  roundIndex: number;
  actorId?: string;
  actorName?: string;
  kind: 'speech' | 'proposal' | 'vote' | 'mission' | 'result' | 'assassin';
  text: string;
  audit?: AiBeliefAudit;
  data?: {
    teamIds?: string[];
    vote?: Vote;
    missionCard?: MissionCard;
    targetPlayerId?: string;
    action?: AiAvalonDecision['action'];
  };
}

export interface DemoAssassination {
  targetPlayerId: string;
  targetName: string;
  hitMerlin: boolean;
  winner: Allegiance;
}

export interface DemoState {
  playerCount: number;
  roleOptions: RolePresetOptions;
  mode: DemoMode;
  humanCount: number;
  players: DemoPlayer[];
  phase: 'setup' | 'proposal' | 'vote' | 'mission' | 'result' | 'assassin' | 'finished';
  roundIndex: number;
  leaderIndex: number;
  proposalIndex: number;
  selectedTeamIds: string[];
  missionResults: DemoMissionResult[];
  tableHistory: DemoHistoryEntry[];
  aiHistory: DemoHistoryEntry[];
  lastVote?: { approveCount: number; rejectCount: number; passed: boolean };
  lastMission?: DemoMissionResult;
  assassination?: DemoAssassination;
  winner?: Allegiance;
}

export type DemoHistoryTone = 'speech' | 'action' | 'reasoning' | 'result';
