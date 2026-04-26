import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  assassinWins,
  assignRoles,
  getTeamSize,
  getVisibilityInfo,
  resolveMission,
  votePasses,
  type MissionCard,
  type Player,
  type Vote,
} from './domain/avalon';
import './styles.css';

type Tab = 'host' | 'player' | 'table';
type Phase = 'setup' | 'reveal' | 'proposal' | 'vote' | 'mission' | 'assassin' | 'finished';

interface EventItem {
  id: string;
  text: string;
}

function App() {
  const [tab, setTab] = useState<Tab>('host');
  const [roomCode, setRoomCode] = useState('AVLN42');
  const [joinCode, setJoinCode] = useState('');
  const [namesText, setNamesText] = useState('Alex\nBao\nCasey\nDevon\nEli');
  const [includePercival, setIncludePercival] = useState(false);
  const [players, setPlayers] = useState<Player[]>([]);
  const [selectedPlayerId, setSelectedPlayerId] = useState('');
  const [phase, setPhase] = useState<Phase>('setup');
  const [roundIndex, setRoundIndex] = useState(0);
  const [leaderIndex, setLeaderIndex] = useState(0);
  const [proposal, setProposal] = useState<string[]>([]);
  const [votes, setVotes] = useState<Record<string, Vote>>({});
  const [missionCards, setMissionCards] = useState<Record<string, MissionCard>>({});
  const [score, setScore] = useState({ success: 0, fail: 0 });
  const [assassinGuess, setAssassinGuess] = useState('');
  const [winner, setWinner] = useState('');
  const [events, setEvents] = useState<EventItem[]>([{ id: 'e0', text: 'TableHost ready for Avalon Lite.' }]);

  const selectedPlayer = players.find((player) => player.id === selectedPlayerId);
  const currentTeamSize = players.length >= 5 && roundIndex < 5 ? getTeamSize(players.length, roundIndex) : 0;
  const proposedPlayers = players.filter((player) => proposal.includes(player.id));
  const missionPlayers = proposedPlayers;
  const voteValues = Object.values(votes);
  const allVotesIn = players.length > 0 && voteValues.length === players.length;
  const allMissionCardsIn = missionPlayers.length > 0 && missionPlayers.every((player) => missionCards[player.id]);

  const nightInfo = useMemo(() => {
    if (!selectedPlayer?.role) return undefined;
    return getVisibilityInfo(selectedPlayer, players);
  }, [selectedPlayer, players]);

  function addEvent(text: string) {
    setEvents((items) => [{ id: `e${Date.now()}-${items.length}`, text }, ...items]);
  }

  function createRoom() {
    const names = namesText
      .split('\n')
      .map((name) => name.trim())
      .filter(Boolean)
      .slice(0, 10);
    if (names.length < 5) return;
    const roster = names.map((name, index) => ({ id: `p${index + 1}`, name }));
    const assigned = assignRoles(roster, { includePercivalMorgana: includePercival }, `${roomCode}-${names.join('|')}`);
    setPlayers(assigned);
    setSelectedPlayerId(assigned[0]?.id ?? '');
    setPhase('reveal');
    setRoundIndex(0);
    setLeaderIndex(0);
    setProposal([]);
    setVotes({});
    setMissionCards({});
    setScore({ success: 0, fail: 0 });
    setWinner('');
    addEvent(`Room ${roomCode} created with ${assigned.length} players.`);
  }

  function joinRoom() {
    if (!joinCode.trim()) return;
    setRoomCode(joinCode.trim().toUpperCase());
    addEvent(`Joined mock room ${joinCode.trim().toUpperCase()} on this device.`);
  }

  function toggleProposal(playerId: string) {
    setProposal((current) => {
      if (current.includes(playerId)) return current.filter((id) => id !== playerId);
      if (current.length >= currentTeamSize) return current;
      return [...current, playerId];
    });
  }

  function startVote() {
    if (proposal.length !== currentTeamSize) return;
    setPhase('vote');
    setVotes({});
    addEvent(`Leader proposed ${proposedPlayers.map((player) => player.name).join(', ')} for mission ${roundIndex + 1}.`);
  }

  function submitVote(playerId: string, vote: Vote) {
    setVotes((current) => ({ ...current, [playerId]: vote }));
  }

  function resolveVote() {
    const passed = votePasses(Object.values(votes), players.length);
    addEvent(`Team vote ${passed ? 'approved' : 'rejected'}: ${countVote('approve')} approve, ${countVote('reject')} reject.`);
    setLeaderIndex((index) => (index + 1) % players.length);
    if (passed) {
      setPhase('mission');
      setMissionCards({});
    } else {
      setPhase('proposal');
      setProposal([]);
    }
  }

  function submitMissionCard(playerId: string, card: MissionCard) {
    setMissionCards((current) => ({ ...current, [playerId]: card }));
  }

  function resolveMissionCards() {
    const result = resolveMission(Object.values(missionCards), players.length, roundIndex);
    const nextScore = {
      success: score.success + (result.outcome === 'success' ? 1 : 0),
      fail: score.fail + (result.outcome === 'fail' ? 1 : 0),
    };
    setScore(nextScore);
    addEvent(`Mission ${roundIndex + 1} ${result.outcome}: ${result.failCount} fail card(s), ${result.requiredFails} required.`);
    setMissionCards({});
    setProposal([]);

    if (nextScore.success >= 3) {
      setPhase('assassin');
      addEvent('Good completed three missions. Assassin may guess Merlin.');
      return;
    }
    if (nextScore.fail >= 3 || roundIndex >= 4) {
      setWinner(nextScore.fail >= 3 ? 'Evil wins by missions.' : 'Game ended after five missions.');
      setPhase('finished');
      return;
    }
    setRoundIndex((round) => round + 1);
    setLeaderIndex((index) => (index + 1) % players.length);
    setPhase('proposal');
  }

  function resolveAssassinGuess() {
    const evilWins = assassinWins(assassinGuess, players);
    setWinner(evilWins ? 'Evil wins: Assassin found Merlin.' : 'Good wins: Merlin survived the guess.');
    setPhase('finished');
    addEvent(evilWins ? 'Assassin guessed Merlin correctly.' : 'Assassin missed Merlin.');
  }

  function countVote(vote: Vote) {
    return Object.values(votes).filter((item) => item === vote).length;
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">TableHost</p>
          <h1>Avalon Lite</h1>
        </div>
        <div className="room-pill">{roomCode}</div>
      </header>

      <nav className="tabs" aria-label="Views">
        {(['host', 'player', 'table'] as Tab[]).map((item) => (
          <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>
            {item}
          </button>
        ))}
      </nav>

      {tab === 'host' && (
        <section className="grid">
          <Panel title="Room setup">
            <label>
              Room code
              <input value={roomCode} onChange={(event) => setRoomCode(event.target.value.toUpperCase())} />
            </label>
            <label>
              Players, one per line
              <textarea value={namesText} onChange={(event) => setNamesText(event.target.value)} rows={8} />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={includePercival}
                onChange={(event) => setIncludePercival(event.target.checked)}
              />
              Include Percival and Morgana for 7+ players
            </label>
            <button className="primary" onClick={createRoom}>Create room and assign roles</button>
          </Panel>

          <Panel title="Host controls">
            <Status phase={phase} roundIndex={roundIndex} score={score} />
            <div className="row">
              <button onClick={() => setPhase('proposal')} disabled={players.length < 5}>Start proposal</button>
              <button onClick={() => setPhase('reveal')} disabled={players.length < 5}>Private reveals</button>
            </div>
            {phase === 'proposal' && (
              <>
                <p>Leader: {players[leaderIndex]?.name}. Pick {currentTeamSize} players.</p>
                <PlayerPicker players={players} selected={proposal} onToggle={toggleProposal} />
                <button className="primary" onClick={startVote} disabled={proposal.length !== currentTeamSize}>Lock team</button>
              </>
            )}
            {phase === 'vote' && (
              <>
                <p>Collect approve/reject votes from every player.</p>
                {players.map((player) => (
                  <div className="vote-row" key={player.id}>
                    <span>{player.name}</span>
                    <button className={votes[player.id] === 'approve' ? 'active-soft' : ''} onClick={() => submitVote(player.id, 'approve')}>Approve</button>
                    <button className={votes[player.id] === 'reject' ? 'active-soft' : ''} onClick={() => submitVote(player.id, 'reject')}>Reject</button>
                  </div>
                ))}
                <button className="primary" onClick={resolveVote} disabled={!allVotesIn}>Reveal vote result</button>
              </>
            )}
            {phase === 'mission' && (
              <>
                <p>Mission team submits hidden cards. Host sees only completion until reveal.</p>
                {missionPlayers.map((player) => (
                  <div className="vote-row" key={player.id}>
                    <span>{player.name}</span>
                    <button className={missionCards[player.id] === 'success' ? 'active-soft' : ''} onClick={() => submitMissionCard(player.id, 'success')}>Success</button>
                    <button className={missionCards[player.id] === 'fail' ? 'active-soft' : ''} onClick={() => submitMissionCard(player.id, 'fail')}>Fail</button>
                  </div>
                ))}
                <button className="primary" onClick={resolveMissionCards} disabled={!allMissionCardsIn}>Reveal mission result</button>
              </>
            )}
            {phase === 'assassin' && (
              <>
                <label>
                  Assassin guess
                  <select value={assassinGuess} onChange={(event) => setAssassinGuess(event.target.value)}>
                    <option value="">Choose Merlin suspect</option>
                    {players.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}
                  </select>
                </label>
                <button className="primary" onClick={resolveAssassinGuess} disabled={!assassinGuess}>Resolve game</button>
              </>
            )}
            {winner && <p className="result">{winner}</p>}
          </Panel>
        </section>
      )}

      {tab === 'player' && (
        <section className="grid">
          <Panel title="Join mock room">
            <label>
              Room code
              <input value={joinCode} onChange={(event) => setJoinCode(event.target.value)} placeholder="AVLN42" />
            </label>
            <button onClick={joinRoom}>Join on this device</button>
          </Panel>
          <Panel title="Private player view">
            <label>
              Device player
              <select value={selectedPlayerId} onChange={(event) => setSelectedPlayerId(event.target.value)}>
                {players.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}
              </select>
            </label>
            {nightInfo ? (
              <div className="role-box">
                <p className="eyebrow">Private reveal</p>
                <h2>{nightInfo.role}</h2>
                <p>{nightInfo.allegiance === 'good' ? 'Good' : 'Evil'} team</p>
                <h3>Night information</h3>
                {nightInfo.sees.length ? (
                  <ul>{nightInfo.sees.map((item) => <li key={item.playerId}>{item.name}: {item.hint}</li>)}</ul>
                ) : (
                  <p>No extra night information.</p>
                )}
              </div>
            ) : (
              <p>Create a room first, then select a player token.</p>
            )}
          </Panel>
        </section>
      )}

      {tab === 'table' && (
        <section className="grid">
          <Panel title="Public table">
            <Status phase={phase} roundIndex={roundIndex} score={score} />
            <p>Leader: {players[leaderIndex]?.name ?? 'Not set'}</p>
            <p>Required team size: {currentTeamSize || '-'}</p>
            <div className="team-list">
              {proposedPlayers.length ? proposedPlayers.map((player) => <span key={player.id}>{player.name}</span>) : <span>No team proposed</span>}
            </div>
          </Panel>
          <Panel title="Timeline">
            <ol className="events">{events.map((event) => <li key={event.id}>{event.text}</li>)}</ol>
          </Panel>
        </section>
      )}
    </main>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Status({ phase, roundIndex, score }: { phase: Phase; roundIndex: number; score: { success: number; fail: number } }) {
  return (
    <div className="status">
      <span>Phase: {phase}</span>
      <span>Mission: {Math.min(roundIndex + 1, 5)}/5</span>
      <span>Good {score.success} - Evil {score.fail}</span>
    </div>
  );
}

function PlayerPicker({ players, selected, onToggle }: { players: Player[]; selected: string[]; onToggle: (id: string) => void }) {
  return (
    <div className="picker">
      {players.map((player) => (
        <button key={player.id} className={selected.includes(player.id) ? 'active-soft' : ''} onClick={() => onToggle(player.id)}>
          {player.name}
        </button>
      ))}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
