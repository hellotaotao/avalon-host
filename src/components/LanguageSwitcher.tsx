import { useI18n } from '../i18n';

export function LanguageSwitcher() {
  const { language, setLanguage, t } = useI18n();
  return (
    <div className="language-switcher" aria-label={t('Language')}>
      <button type="button" className={language === 'en' ? 'selected' : ''} onClick={() => setLanguage('en')}>{t('English')}</button>
      <button type="button" className={language === 'zh' ? 'selected' : ''} onClick={() => setLanguage('zh')}>{t('中文')}</button>
    </div>
  );
}
