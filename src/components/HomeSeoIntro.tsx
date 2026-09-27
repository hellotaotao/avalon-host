import { useI18n } from '../i18n';

export function HomeSeoIntro() {
  const { t } = useI18n();

  return (
    <section className="home-seo" aria-labelledby="home-seo-title">
      <div className="home-seo-copy">
        <p className="eyebrow">{t('Medieval table, modern phones')}</p>
        <h2 id="home-seo-title">{t('Built for friends at the same table')}</h2>
        <p>{t('Veiled Roundtable is a mobile Avalon board game assistant for hidden identities, quest voting, and the Merlin assassination endgame.')}</p>
        <p>{t('The host opens a room, everyone scans the code or types the 5-digit number, and each phone privately shows that player their role. Votes, quest cards, and the score are tallied automatically.')}</p>
        <div className="seo-tags" aria-label={t('Avalon assistant highlights')}>
          <span>{t('Scan to join')}</span>
          <span>{t('Private phone reveals')}</span>
          <span>{t('Quest votes and Merlin endgame')}</span>
          <span>{t('Automatic scoring')}</span>
        </div>
      </div>
      <figure className="home-seo-art">
        <img
          src="/seo/avalon-phone-table.jpg"
          alt={t('Phones around a candlelit Avalon round table')}
          loading="lazy"
          width="1448"
          height="1086"
        />
        <img
          className="home-seo-castle"
          src="/seo/veiled-roundtable-room.jpg"
          alt={t('Misty castle council room with a round table')}
          loading="lazy"
          width="1672"
          height="941"
        />
      </figure>
    </section>
  );
}
