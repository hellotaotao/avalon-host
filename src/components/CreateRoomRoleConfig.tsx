import {
  buildRolePreset,
  getPlayerCountRule,
  playerCountRange,
  roleAllegiance,
  type Role,
  type RolePresetOptions,
} from '../domain/avalon';
import { LADY_OF_THE_LAKE_MIN_PLAYERS } from '../domain/missionFlow';
import { resolveCreateRoomSeats } from '../services/roomService';
import { formatRole, useI18n } from '../i18n';
import { formatRoleCount, summarizeRoleEntries } from './gameText';

export function CreateRoomRoleConfig({
  aiFillEnabled,
  humanPlayerCount,
  playerCount,
  roleOptions,
  ladyOfTheLake,
  onLadyOfTheLakeChange,
  onAiFillEnabledChange,
  onHumanPlayerCountChange,
  onPlayerCountChange,
  onToggleRole,
}: {
  aiFillEnabled: boolean;
  humanPlayerCount: number;
  playerCount: (typeof playerCountRange)[number];
  roleOptions: RolePresetOptions;
  ladyOfTheLake: boolean;
  onLadyOfTheLakeChange: (enabled: boolean) => void;
  onAiFillEnabledChange: (enabled: boolean) => void;
  onHumanPlayerCountChange: (playerCount: number) => void;
  onPlayerCountChange: (playerCount: (typeof playerCountRange)[number]) => void;
  onToggleRole: (key: keyof RolePresetOptions) => void;
}) {
  const { t, language } = useI18n();
  const rule = getPlayerCountRule(playerCount);
  const preset = buildRolePreset(playerCount, roleOptions);
  const goodRoles = preset.roles.filter((role) => roleAllegiance(role) === 'good');
  const evilRoles = preset.roles.filter((role) => roleAllegiance(role) === 'evil');
  const seats = resolveCreateRoomSeats({ playerCount, aiFillEnabled, humanPlayerCount });
  const aiCount = seats.plannedPlayerCount - seats.humanPlayerCount;
  const ladyAvailable = playerCount >= LADY_OF_THE_LAKE_MIN_PLAYERS;

  return (
    <section className="create-role-config" aria-label={t('Role configuration')}>
      <div>
        <h3>{t('Player count')}</h3>
        <div className="segmented" aria-label={t('Player count')}>
          {playerCountRange.map((count) => (
            <button
              key={count}
              type="button"
              className={count === playerCount ? 'selected' : ''}
              onClick={() => onPlayerCountChange(count)}
            >
              {count}
            </button>
          ))}
        </div>
        <p className="create-role-summary">{rule.goodCount} {t('Good')} / {rule.evilCount} {t('Evil')}</p>
        {aiCount > 0 && (
          <div className="ai-fill-note">
            <strong>{seats.humanPlayerCount} {t(seats.humanPlayerCount === 1 ? 'human' : 'humans')} + {aiCount} {t('AI')}</strong>
            <span>{t('AI seats are labeled in the room and act automatically.')}</span>
          </div>
        )}
      </div>

      <div>
        <h3>{t('Role setup')}</h3>
        <p className="hint">{t('Recommended roles for this player count. Special roles can be changed under Advanced settings.')}</p>
        <div className="create-role-sides">
          <RoleList title={t('Good roles')} roles={goodRoles} language={language} />
          <RoleList title={t('Evil roles')} roles={evilRoles} language={language} />
        </div>
      </div>

      <details className="create-advanced">
        <summary>{t('Advanced settings')}</summary>
        <div>
          <h3>{t('Special roles')}</h3>
          <div className="role-option-chips" aria-label={t('Special roles')}>
            {optionalRoleControls.map((control) => {
              const checked = Boolean(roleOptions[control.key]);
              const disabled = !checked && !canEnableRoleOption(playerCount, roleOptions, control.key);
              return (
                <button
                  key={control.key}
                  type="button"
                  className={`role-option-chip ${checked ? 'selected' : ''}`}
                  aria-pressed={checked}
                  disabled={disabled}
                  onClick={() => onToggleRole(control.key)}
                >
                  <span>{formatRole(control.role, language)}</span>
                  <small>{t(control.note)}</small>
                </button>
              );
            })}
          </div>
        </div>

        <div className="create-lady">
          <h3>{t('Lady of the Lake')}</h3>
          <label className="create-ai-toggle">
            <input
              type="checkbox"
              checked={ladyAvailable && ladyOfTheLake}
              disabled={!ladyAvailable}
              onChange={(event) => onLadyOfTheLakeChange(event.target.checked)}
            />
            <span>{t('Use the Lady of the Lake')}</span>
          </label>
          <p className="hint">
            {ladyAvailable
              ? t('After quests 2, 3, and 4, the holder secretly checks one player\'s allegiance, then hands the Lady to them.')
              : t('Available for 7 or more players.')}
          </p>
        </div>

        <div className="create-ai-fill">
          <h3>{t('AI fill-ins (experimental)')}</h3>
          <label className="create-ai-toggle">
            <input type="checkbox" checked={aiFillEnabled} onChange={(event) => onAiFillEnabledChange(event.target.checked)} />
            <span>{t('Fill empty seats with AI')}</span>
          </label>
          <p className="hint">{t("For short tables or solo testing. AI moves are driven by the host's page, so keep it open during the game.")}</p>
          {aiFillEnabled && (
            <div>
              <h4>{t('Human players')}</h4>
              <div className="segmented" aria-label={t('Human player count')}>
                {Array.from({ length: playerCount - 1 }, (_, index) => index + 1).map((count) => (
                  <button
                    key={count}
                    type="button"
                    className={count === seats.humanPlayerCount ? 'selected' : ''}
                    onClick={() => onHumanPlayerCountChange(count)}
                  >
                    {count}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </details>
    </section>
  );
}

function RoleList({ title, roles, language }: { title: string; roles: Role[]; language: ReturnType<typeof useI18n>['language'] }) {
  return (
    <div className="create-role-list">
      <span>{title}</span>
      <div>
        {summarizeRoleEntries(roles).map((item) => (
          <span key={item.role} className={`role-chip ${roleAllegiance(item.role)}`}>
            {formatRoleCount(item.role, item.count, language)}
          </span>
        ))}
      </div>
    </div>
  );
}

export const optionalRoleControls: Array<{ key: keyof RolePresetOptions; role: Role; label: string; note: string }> = [
  { key: 'includePercival', role: 'Percival', label: 'Percival', note: 'Good, sees Merlin candidates.' },
  { key: 'includeMorgana', role: 'Morgana', label: 'Morgana', note: 'Evil, appears as Merlin candidate.' },
  { key: 'includeMordred', role: 'Mordred', label: 'Mordred', note: 'Evil, hidden from Merlin.' },
  { key: 'includeOberon', role: 'Oberon', label: 'Oberon', note: 'Evil, hidden from other evil.' },
];

export function sanitizeRoleOptions(playerCount: number, roleOptions: RolePresetOptions): RolePresetOptions {
  return optionalRoleControls.reduce<RolePresetOptions>((next, control) => {
    if (!roleOptions[control.key]) return next;
    const candidate = { ...next, [control.key]: true };
    try {
      buildRolePreset(playerCount, candidate);
      return candidate;
    } catch {
      return next;
    }
  }, {});
}

export function canEnableRoleOption(playerCount: number, roleOptions: RolePresetOptions, key: keyof RolePresetOptions): boolean {
  try {
    buildRolePreset(playerCount, { ...roleOptions, [key]: true });
    return true;
  } catch {
    return false;
  }
}
