import { describe, expect, it } from 'vitest';
import {
  assignRoles,
  assassinWins,
  getRoleDistribution,
  getTeamSize,
  getVisibilityInfo,
  resolveMission,
  roleAllegiance,
  votePasses,
  type Player,
} from './avalon';

describe('Avalon Lite rules', () => {
  it('creates role distributions for 5-10 players', () => {
    for (const count of [5, 6, 7, 8, 9, 10]) {
      const roles = getRoleDistribution(count);
      expect(roles).toHaveLength(count);
      expect(roles.filter((role) => role === 'Merlin')).toHaveLength(1);
      expect(roles.filter((role) => role === 'Assassin')).toHaveLength(1);
    }
  });

  it('supports optional Percival and Morgana for larger tables', () => {
    const roles = getRoleDistribution(7, { includePercivalMorgana: true });
    expect(roles).toContain('Percival');
    expect(roles).toContain('Morgana');
    expect(roles.filter((role) => roleAllegiance(role) === 'evil')).toHaveLength(3);
  });

  it('assigns every player exactly one required role set', () => {
    const players = makePlayers(6);
    const assigned = assignRoles(players, {}, 'seed-a');
    expect(assigned.every((player) => player.role)).toBe(true);
    expect(assigned.map((player) => player.role)).toContain('Merlin');
    expect(assigned.map((player) => player.role)).toContain('Assassin');
  });

  it('returns official team sizes by player count and round', () => {
    expect([0, 1, 2, 3, 4].map((round) => getTeamSize(5, round))).toEqual([2, 3, 2, 3, 3]);
    expect([0, 1, 2, 3, 4].map((round) => getTeamSize(10, round))).toEqual([3, 4, 4, 5, 5]);
  });

  it('requires strict majority for team voting', () => {
    expect(votePasses(['approve', 'approve', 'approve', 'reject', 'reject'], 5)).toBe(true);
    expect(votePasses(['approve', 'approve', 'reject', 'reject', 'reject'], 5)).toBe(false);
    expect(votePasses(['approve', 'approve', 'approve', 'reject', 'reject', 'reject'], 6)).toBe(false);
  });

  it('resolves missions with the two-fail fourth quest rule at 7+ players', () => {
    expect(resolveMission(['success', 'fail'], 5, 0).outcome).toBe('fail');
    expect(resolveMission(['success', 'fail', 'success', 'success'], 7, 3).outcome).toBe('success');
    expect(resolveMission(['fail', 'fail', 'success', 'success'], 7, 3).outcome).toBe('fail');
  });

  it('shows Merlin evil players and evil players their teammates', () => {
    const players: Player[] = [
      { id: 'p1', name: 'A', role: 'Merlin' },
      { id: 'p2', name: 'B', role: 'Assassin' },
      { id: 'p3', name: 'C', role: 'Minion' },
      { id: 'p4', name: 'D', role: 'Loyal Servant' },
      { id: 'p5', name: 'E', role: 'Loyal Servant' },
    ];
    expect(getVisibilityInfo(players[0], players).sees.map((item) => item.playerId)).toEqual(['p2', 'p3']);
    expect(getVisibilityInfo(players[1], players).sees.map((item) => item.playerId)).toEqual(['p3']);
  });

  it('shows Percival Merlin and Morgana as candidates', () => {
    const players: Player[] = [
      { id: 'p1', name: 'A', role: 'Merlin' },
      { id: 'p2', name: 'B', role: 'Morgana' },
      { id: 'p3', name: 'C', role: 'Percival' },
      { id: 'p4', name: 'D', role: 'Assassin' },
      { id: 'p5', name: 'E', role: 'Loyal Servant' },
      { id: 'p6', name: 'F', role: 'Loyal Servant' },
      { id: 'p7', name: 'G', role: 'Minion' },
    ];
    expect(getVisibilityInfo(players[2], players).sees.map((item) => item.playerId).sort()).toEqual(['p1', 'p2']);
  });

  it('assassin wins by guessing Merlin', () => {
    const players = [{ id: 'p1', name: 'A', role: 'Merlin' as const }];
    expect(assassinWins('p1', players)).toBe(true);
    expect(assassinWins('p2', players)).toBe(false);
  });
});

function makePlayers(count: number): Player[] {
  return Array.from({ length: count }, (_, index) => ({ id: `p${index + 1}`, name: `Player ${index + 1}` }));
}
