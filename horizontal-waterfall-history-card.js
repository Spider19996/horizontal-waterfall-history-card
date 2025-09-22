const threshold_default_number = [
  { value: 60, color: '#4FC3F7' },  // cold
  { value: 70, color: '#81C784' },  // cool
  { value: 80, color: '#FFB74D' },  // warm
  { value: 100, color: '#FF8A65' }  // hot
];
const threshold_default_boolean = [
  { value: 0, color: '#636363' },  // off
  { value: 1, color: '#EEEEEE' },  // on
];

class waterfallHistoryCard extends HTMLElement {
  // FIX: Hardcoded default domain icons
  DEFAULT_DOMAIN_ICONS = {
    sensor: "mdi:gauge",
    binary_sensor: "mdi:eye",
    switch: "mdi:toggle-switch",
    light: "mdi:lightbulb",
    climate: "mdi:thermostat",
    lock: "mdi:lock",
    cover: "mdi:window-shutter",
    media_player: "mdi:play-circle",
    person: "mdi:account",
    device_tracker: "mdi:map-marker",
  };

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._lastHistoryFetch = {}; // Timestamp of last fetch per entity
    this._historyRefreshInterval = 15 * 60 * 1000; // 15min by default

    this.translations = {
      en: {
        history: 'History',
        error_loading_data: 'Error loading historical data',
        min_label: 'Min',
        max_label: 'Max',
        hours_ago: 'h ago',
        minutes_ago: 'm ago',
        now: 'Now',
        language_label: 'Language',
        language_auto: 'Auto',
        language_en: 'English',
        language_de: 'German',
        language_fr: 'French',
      },
      de: {
        history: 'Verlauf',
        error_loading_data: 'Fehler beim Laden der Verlaufsdaten',
        min_label: 'Min',
        max_label: 'Max',
        hours_ago: 'Std. zuvor',
        minutes_ago: 'Min. zuvor',
        now: 'Jetzt',
        language_label: 'Sprache',
        language_auto: 'Auto',
        language_en: 'Englisch',
        language_de: 'Deutsch',
        language_fr: 'Französisch',
      },
      fr: {
        history: 'Historique',
        error_loading_data: 'Erreur lors du chargement des données historiques',
        min_label: 'Min',
        max_label: 'Max',
        hours_ago: 'h',
        minutes_ago: 'min',
        now: 'Actuel',
        language_label: 'Langue',
        language_auto: 'Auto',
        language_en: 'Anglais',
        language_de: 'Allemand',
        language_fr: 'Français',
      }
    };

    this.language = 'en';
    this.t = (key) => {
      const lang = this.translations[this.language] ? this.language : 'en';
      return this.translations[lang][key] ?? this.translations.en[key] ?? key;
    };
  }

  setConfig(config) {
    // FIX: ensure config object exists before accessing properties
    this.config = this.config || {};
    this._hasCustomTitle = !!config.title;

    const normalizedLanguage = this.normalizeLanguageOption(config.language ?? 'auto');
    const fallbackLanguage = normalizedLanguage === 'auto' ? this.language : normalizedLanguage;
    this.language = this.translations[fallbackLanguage] ? fallbackLanguage : 'en';

    if (!config.entities || !Array.isArray(config.entities) || config.entities.length === 0) {
      throw new Error('Please define a list of entities.');
    }

    const parseNumber = (value, fallback) => {
        if (value === undefined || value === null || value === '') {
            return fallback;
        }
        const num = Number(value);
        return Number.isFinite(num) ? num : fallback;
    };

    const globalConfig = {
        title: config.title || (this.translations[this.language]?.history ?? this.translations.en.history),
        hours: parseNumber(config.hours, 24),
        intervals: parseNumber(config.intervals, 48),
        height: parseNumber(config.height, 60),
        min_value: config.min_value ?? null,
        max_value: config.max_value ?? null,
        thresholds: config.thresholds ?? null,
        gradient: config.gradient === true,
        show_current: config.show_current !== false,
        show_labels: config.show_labels !== false,
        show_min_max: config.show_min_max !== false,
        show_icons: config.show_icons !== false,
        unit: config.unit || null,
        icon: config.icon || null,
        compact: config.compact === true,
        default_value: config.default_value ?? null,
        digits: parseNumber(config.digits, 1),
        card_mod: config.card_mod || {},
        language: normalizedLanguage,
    };

    this.config = {
        ...globalConfig,
        entities: config.entities.map(entityConfig => {
            if (typeof entityConfig === 'string') {
                return { entity: entityConfig };
            }
            return { ...entityConfig };
        }),
    };
  }

  set hass(hass) {
    this._hass = hass;

    const configLanguage = this.normalizeLanguageOption(this.config?.language ?? 'auto');
    let resolvedLanguage = 'en';
    if (configLanguage === 'auto') {
      const hassLangSource = hass.selectedLanguage || hass.language || (hass.locale && hass.locale.language) || 'en';
      const hassLanguage = hassLangSource.toString().split('-')[0].toLowerCase();
      resolvedLanguage = this.translations[hassLanguage] ? hassLanguage : 'en';
    } else {
      resolvedLanguage = this.translations[configLanguage] ? configLanguage : 'en';
    }

    this.language = resolvedLanguage;

    if (!this._hasCustomTitle && this.config) {
      this.config.title = this.translations[this.language]?.history ?? this.translations.en.history;
    }

    this.updateCard();
    this.updateCurrentValues();
  }

  updateCurrentValues() {
    if (!this.shadowRoot) return;

    this.config.entities.forEach(entityConfig => {
      const entityId = entityConfig.entity;
      const entity = this._hass.states[entityId];
      if (!entity) return;
      
      const showCurrent = entityConfig.show_current ?? this.config.show_current;
      if (!showCurrent) return;

      const current = this.parseState(entity.state);
      const valueElem = this.shadowRoot.querySelector(`.current-value[data-entity="${entityId}"]`);
      if (valueElem) {
        valueElem.textContent = this.displayState(current, entityConfig);
      }

      const lastBar = this.shadowRoot.querySelector(`.bar-segment[data-entity="${entityId}"].last-bar`);
      if (lastBar && current != null) {
        lastBar.style.backgroundColor = this.getColorForValue(current, entityConfig);
        lastBar.setAttribute('title', `${this.displayState(current, entityConfig)} - ${this.t('now')}`);
      }
    });
  }

  async updateCard() {
    if (!this._hass || !this.config) return;

    const now = Date.now();
    
    const entitiesToUpdate = this.config.entities.filter(entityConfig => {
        const entityId = entityConfig.entity;
        const hours = entityConfig.hours ?? this.config.hours;
        const intervals = entityConfig.intervals ?? this.config.intervals;
        const refreshInterval = ((hours / intervals) * 60 * 60 * 1000) / 2;
        return !this._lastHistoryFetch[entityId] || (now - this._lastHistoryFetch[entityId] > refreshInterval);
    });

    if (entitiesToUpdate.length === 0 && this.shadowRoot.innerHTML) {
      // Nothing to update and card is already rendered
      return;
    }
    
    const historyPromises = entitiesToUpdate.map(async (entityConfig) => {
        const entityId = entityConfig.entity;
        const hours = entityConfig.hours ?? this.config.hours;
        const endTime = new Date();
        const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);

        try {
            const history = await this._hass.callApi('GET',
                `history/period/${startTime.toISOString()}?filter_entity_id=${entityId}&end_time=${endTime.toISOString()}&significant_changes_only=1&minimal_response&no_attributes&skip_initial_state`
            );
            this._lastHistoryFetch[entityId] = now;
            return { entityId, history: history[0], entityConfig };
        } catch (error) {
            console.error(`Error fetching history for ${entityId}:`, error);
            return { entityId, history: null, entityConfig }; // Return null on error to handle it gracefully
        }
    });

    const results = await Promise.all(historyPromises);

    const processedHistories = this.processedHistories || {};
    results.forEach(({ entityId, history, entityConfig }) => {
        if(history){
            const intervals = entityConfig.intervals ?? this.config.intervals;
            const hours = entityConfig.hours ?? this.config.hours;
            const timeStep = (hours * 60 * 60 * 1000) / intervals;
            processedHistories[entityId] = this.processHistoryData(history, intervals, timeStep, entityConfig);
        }
    });
    this.processedHistories = processedHistories;

    this.renderCard(this.processedHistories);
  }

  renderCard(processedHistories) {
    this.shadowRoot.innerHTML = `
      <style>
        /* FIX: Keep icon+name on the left, value on the right */
        .entity-header { display: flex; align-items: center; gap: 8px; }
        .current-value { margin-left: auto; }
        .entity-icon { width: 20px; height: 20px; }

        :host {
          padding: 16px;
          background: var(--ha-card-background, var(--card-background-color, #fff));
          box-shadow: var(--ha-card-box-shadow, none);
          box-sizing: border-box;
          border-radius: var(--ha-card-border-radius, 12px);
          border-width: var(--ha-card-border-width, 1px);
          border-style: solid;
          border-color: var(--ha-card-border-color, var(--divider-color, #e0e0e0));
          color: var(--primary-text-color);
          display: block;
          position: relative;
        }
        .card-header {
          font-size: ${this.config.compact ? "12px" : "16px"};
          font-weight: 500;
          padding-bottom: 8px;
          color: var(--primary-text-color, black);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .entity-container {
          margin-bottom: 16px;
          cursor: pointer;
        }
        .entity-container:last-child {
            margin-bottom: 0;
        }
        .entity-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 4px;
        }
        .entity-name {
          font-size: ${this.config.compact ? "12px" : "14px"};
          font-weight: 500;
        }
        .current-value {
          font-size: ${this.config.compact ? "12px" : "18px"};
          font-weight: bold;
        }
        .waterfall-container {
          position: relative;
          height: ${this.config.height}px;
          border-radius: 2px;
          overflow: hidden;
          display: flex;
        }
        .bar-segment {
          flex: 1;
          height: 100%;
          transition: all 0.3s ease;
          border-right: 1px solid rgba(255,255,255,0.2);
        }
        .bar-segment:last-child {
          border-right: none;
        }
        .labels {
          display: flex;
          justify-content: space-between;
          font-size: 11px;
          color: var(--secondary-text-color, gray);
          margin-top: ${this.config.compact ? "0px" : "4px"};
        }
        .min-max-label {
          font-size: 11px;
          color: var(--secondary-text-color, gray);
          text-align: center;
        }
        .error {
          color: var(--error-color, red);
        }
      </style>
      <div class="card-header">
        <span>${this.config.title}</span>
      </div>
      ${this.config.entities.map(entityConfig => {
        const entityId = entityConfig.entity;
        const entity = this._hass.states[entityId];
        if (!entity) return `<div class="error">Entity not found: ${entityId}</div>`;

        const name = entityConfig.name || entity.attributes.friendly_name || entityId;
                // FIX: derive icon per-entity if provided on the state
        // FIX: resolve icon per entity with domain fallback
        let icon = entityConfig.icon;
        if (typeof icon === 'string') {
          icon = icon.trim();
        }
        if (!icon) {
          if (entity.attributes && entity.attributes.icon) {
            icon = entity.attributes.icon;
          } else {
            const domain = entityId.split('.')[0];
            icon = this.DEFAULT_DOMAIN_ICONS[domain] || 'mdi:bookmark';
          }
        }
        // FIX: resolve show_icons safely even if this.config is not yet defined
        const globalShowIcons = (this && this.config && this.config.show_icons !== undefined) ? this.config.show_icons : true;
        const perEntityShowIcons = (entityConfig.show_icons !== undefined) ? entityConfig.show_icons : globalShowIcons;
        const iconHtml = (perEntityShowIcons && icon) ? `<ha-icon class="entity-icon" icon="${icon}"></ha-icon>` : '';
const history = [...(processedHistories[entityId] || [])];
        const current = this.parseState(entity.state);
        history.push(current);
        
        const [actualMin, actualMax] = this.getMinMax(history);
        
        const showLabels = entityConfig.show_labels ?? this.config.show_labels;
        const showMinMax = entityConfig.show_min_max ?? this.config.show_min_max;
        const showCurrent = entityConfig.show_current ?? this.config.show_current;
        const hours = entityConfig.hours ?? this.config.hours;
        const intervals = entityConfig.intervals ?? this.config.intervals;
        
        return `
          <div class="entity-container" data-entity-id="${entityId}" >
            <div class="entity-header">
              ${iconHtml}
              <span class="entity-name">${name}</span>
              ${showCurrent ? `<span class="current-value" data-entity="${entityId}">${this.displayState(current, entityConfig)}</span>` : ''}
            </div>
            <div class="waterfall-container">
              ${history.map((value, index) => {
                const isLast = index === history.length - 1;
                const color = this.getColorForValue(value, entityConfig);
                return `<div class="bar-segment ${isLast ? 'last-bar' : ''}"
                             data-entity="${entityId}"
                             style="background-color: ${color};"
                             title="${this.getTimeLabel(index, intervals, hours)} : ${value !== null ? this.displayState(value, entityConfig) : this.t('error_loading_data')}">
                        </div>`;
              }).join('')}
            </div>
            ${showLabels ? `
              <div class="labels">
                <span>${hours}${this.t('hours_ago')}</span>
                <span>${this.t('now')}</span>
              </div>
            ` : ''}
            ${showMinMax ? `
              <div class="min-max-label">
                ${this.t('min_label')}: ${this.displayState(actualMin, entityConfig)} / ${this.t('max_label')}: ${this.displayState(actualMax, entityConfig)}
              </div>
            ` : ''}
          </div>
        `;
      }).join('')}
    `;

    customElements.whenDefined("card-mod").then((cardMod) => {
      cardMod.applyToElement(this, "card", this.config.card_mod);
    });
  
    // Attach real click handlers for More Info (HA)
    const containers = this.shadowRoot.querySelectorAll('.entity-container');
    containers.forEach((el) => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', (ev) => {
        // Try to resolve the entity id from composedPath()
        const path = ev.composedPath ? ev.composedPath() : [];
        let id = el.dataset.entityId;
        for (const node of path) {
          if (node && node.dataset) {
            if (node.dataset.entityId) { id = node.dataset.entityId; break; }
            if (node.dataset.entity) { id = node.dataset.entity; break; }
          }
        }
        if (id) {
          ev.stopPropagation();
          this.openMoreInfo(id);
        }
      });
    });
  }

  normalizeLanguageOption(option) {
    if (option === undefined || option === null) return 'auto';
    const value = String(option).trim().toLowerCase();
    const map = {
      auto: 'auto',
      automatic: 'auto',
      en: 'en',
      english: 'en',
      anglais: 'en',
      englisch: 'en',
      de: 'de',
      german: 'de',
      deutsch: 'de',
      fr: 'fr',
      french: 'fr',
      francais: 'fr',
      français: 'fr',
    };
    return map[value] || value;
  }

  processHistoryData(historyData, intervals, timeStep, entityConfig) {
    const defaultValue = entityConfig.default_value ?? this.config.default_value;
    const processed = new Array(intervals).fill(defaultValue);
    const hours = entityConfig.hours ?? this.config.hours;
    const startTime = Date.now() - (hours * 60 * 60 * 1000);

    if (historyData) {
        historyData.forEach(point => {
          const pointTime = new Date(point.last_changed || point.last_updated).getTime();
          const timeDiff = pointTime - startTime;
          if (timeDiff >= 0) {
            const bucketIndex = Math.floor(timeDiff / timeStep);
            if (bucketIndex >= 0 && bucketIndex < intervals) {
              processed[bucketIndex] = this.parseState(point.state);
            }
          }
        });
    }

    for (let i = 1; i < processed.length; i++) {
        if (processed[i] === null && processed[i - 1] !== null) {
            processed[i] = processed[i - 1];
        }
    }
    for (let i = processed.length - 2; i >= 0; i--) {
        if (processed[i] === null && processed[i + 1] !== null) {
            processed[i] = processed[i + 1];
        }
    }

    return processed;
  }

  getMinMax(data) {
    let min = Infinity;
    let max = -Infinity;
    data.forEach(d => {
        if (d === null) return;
        if (d > max) max = d;
        if (d < min) min = d;
    });
    return [min, max];
  }

  parseState(state) {
    if (typeof state === 'number') return state;
    if (typeof state === 'string') {
      if (state.toLowerCase() === 'off') return 0;
      if (state.toLowerCase() === 'on') return 1;
      const casted = parseFloat(state);
      if (!Number.isNaN(casted)) return casted;
    }
    return null;
  }

  displayState(state, entityConfig) {
      if (state === true || state === 1 && (entityConfig.thresholds === threshold_default_boolean || this.config.thresholds === threshold_default_boolean)) return 'on';
      if (state === false || state === 0 && (entityConfig.thresholds === threshold_default_boolean || this.config.thresholds === threshold_default_boolean)) return 'off';
      if (typeof state === 'number') {
          const digits = entityConfig.digits ?? this.config.digits;
          return state.toFixed(digits) + this.getUnit(entityConfig);
      }
      return (state ?? 'N/A') + this.getUnit(entityConfig);
  }

  getColorForValue(value, entityConfig) {
    if (value === null || isNaN(value)) return '#666666';

    let thresholds = entityConfig.thresholds ?? this.config.thresholds;
    if (!thresholds) {
        thresholds = (typeof value === 'boolean' || value === 0 || value === 1) ? threshold_default_boolean : threshold_default_number;
    }
    
    if (typeof value === 'boolean') value = value ? 1 : 0;

    const gradient = entityConfig.gradient ?? this.config.gradient;
    if (!gradient) {
        let color = thresholds[0].color;
        for (const t of thresholds) {
            if (value >= t.value) {
                color = t.color;
            }
        }
        return color;
    }

    for (let i = 0; i < thresholds.length - 1; i++) {
        const current = thresholds[i];
        const next = thresholds[i + 1];
        if (value >= current.value && value <= next.value) {
            const factor = (next.value - current.value === 0) ? 0 : (value - current.value) / (next.value - current.value);
            return this.interpolateColor(current.color, next.color, factor);
        }
    }
    return value < thresholds[0].value ? thresholds[0].color : thresholds[thresholds.length - 1].color;
  }

  getUnit(entityConfig) {
      const entity = this._hass.states[entityConfig.entity];
      return entityConfig.unit ?? this.config.unit ?? entity?.attributes?.unit_of_measurement ?? '';
  }

  interpolateColor(color1, color2, factor) {
    const c1 = this.hexToRgb(color1);
    const c2 = this.hexToRgb(color2);
    const r = Math.round(c1.r + (c2.r - c1.r) * factor);
    const g = Math.round(c1.g + (c2.g - c1.g) * factor);
    const b = Math.round(c1.b + (c2.b - c1.b) * factor);
    return `rgb(${r}, ${g}, ${b})`;
  }

  hexToRgb(hex) {
    const res = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return res ? { r: parseInt(res[1], 16), g: parseInt(res[2], 16), b: parseInt(res[3], 16) } : { r: 0, g: 0, b: 0 };
  }

  getTimeLabel(index, totalIntervals, hours) {
    const hoursAgo = (hours * (totalIntervals - index)) / totalIntervals;
    if (hours <= 24) {
        const date = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
        const nextDate = new Date(date.getTime() + (hours / totalIntervals) * 60 * 60 * 1000);
        return `${date.getHours()}:00 - ${nextDate.getHours()}:00`;
    }
    if (hoursAgo < 1) {
        return `${Math.round(hoursAgo * 60)}${this.t('minutes_ago')}`;
    }
    return `${hoursAgo.toFixed(1)}${this.t('hours_ago')}`;
  }

  openMoreInfo(entityId) {
    const event = new CustomEvent('hass-more-info', {
      bubbles: true,
      composed: true,
      detail: { entityId }
    });
    this.dispatchEvent(event);
  }

  getCardSize() {
    return this.config.entities.length * 2;
  }

  static getStubConfig() {
    return {
      title: 'Temperature History',
      hours: 24,
      show_min_max: true,
      entities: [
        {
            entity: 'sensor.outdoor_temperature',
            name: 'Outside',
            show_min_max: false, // Override global setting
        },
        {
            entity: 'sensor.indoor_temperature',
            name: 'Inside (48h)',
            hours: 48, // Override global setting
            show_labels: false,
        },
        {
            entity: 'sensor.attic_temperature',
            name: 'Attic',
        },
      ],
    };
  }

  static async getConfigElement() {
    return document.createElement('waterfall-history-card-editor');
  }
}

if (!customElements.get('waterfall-history-card')) {
  customElements.define('waterfall-history-card', waterfallHistoryCard);
}

class WaterfallHistoryCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = { entities: [] };
    this._selectedTab = 0;
    this._shouldFocusSelectedTab = false;
    this._hasRendered = false;
    this._lastConfigString = null;
    this._waitingForEntityPicker = false;
  }

  set hass(hass) {
    this._hass = hass;

    if (!this._hasRendered) {
      this.render();
      return;
    }

    this.shadowRoot
      ?.querySelectorAll('ha-entity-picker[data-field="entity"]')
      .forEach((picker) => {
        picker.hass = hass;
      });
  }

  setConfig(config) {
    const normalized = this._normalizeConfig(config);
    const normalizedString = this._stringifyConfig(normalized);

    if (this._lastConfigString && this._lastConfigString === normalizedString) {
      this._config = normalized;
      this._lastConfigString = normalizedString;
      return;
    }

    this._config = normalized;
    this._lastConfigString = normalizedString;

    if (this._selectedTab > 2) {
      this._selectedTab = 0;
    }

    this.render();
  }

  _normalizeConfig(config) {
    const base = typeof config === 'object' && config !== null ? config : {};

    const entities = Array.isArray(base.entities)
      ? base.entities.map((entity) => (typeof entity === 'string' ? { entity } : { ...entity }))
      : [];

    const thresholds = Array.isArray(base.thresholds)
      ? base.thresholds.map((threshold) => ({ ...threshold }))
      : base.thresholds === null
        ? null
        : threshold_default_number.map((threshold) => ({ ...threshold }));

    const normalized = {
      ...base,
      entities,
      thresholds,
    };

    if (thresholds === null) {
      normalized.thresholds = null;
    }

    return normalized;
  }

  _stringifyConfig(value) {
    if (value === undefined) {
      return '';
    }
    return JSON.stringify(this._sortObjectForHash(value));
  }

  _sortObjectForHash(value) {
    if (Array.isArray(value)) {
      return value.map((item) => this._sortObjectForHash(item));
    }

    if (value && typeof value === 'object') {
      const sorted = {};
      Object.keys(value)
        .sort()
        .forEach((key) => {
          const child = value[key];
          if (child !== undefined) {
            sorted[key] = this._sortObjectForHash(child);
          }
        });
      return sorted;
    }

    return value;
  }

  get _entities() {
    return this._config.entities || [];
  }

  render() {
    if (!this.shadowRoot) return;

    const tabs = ['Allgemein', 'Darstellung', 'Entitäten'];
    const languageValue = this._config.language ?? 'auto';

    const generalTab = `
      <div class="form-grid">
        <ha-textfield
          label="Titel"
          data-field="title"
          value="${this._config.title ?? ''}"
        ></ha-textfield>
        <ha-textfield
          label="Stunden"
          type="number"
          min="1"
          step="1"
          data-field="hours"
          value="${this._config.hours ?? ''}"
        ></ha-textfield>
        <ha-textfield
          label="Intervalle"
          type="number"
          min="1"
          step="1"
          data-field="intervals"
          value="${this._config.intervals ?? ''}"
        ></ha-textfield>
        <ha-textfield
          label="Höhe (px)"
          type="number"
          min="10"
          step="1"
          data-field="height"
          value="${this._config.height ?? ''}"
        ></ha-textfield>
        <ha-select
          label="Sprache"
          data-field="language"
          data-value="${languageValue}"
        >
          <mwc-list-item value="auto">Automatisch</mwc-list-item>
          <mwc-list-item value="en">English</mwc-list-item>
          <mwc-list-item value="de">Deutsch</mwc-list-item>
          <mwc-list-item value="fr">Français</mwc-list-item>
        </ha-select>
      </div>
    `;

    const thresholds = Array.isArray(this._config.thresholds)
      ? this._config.thresholds.map((threshold) => ({ ...threshold }))
      : [];

    const thresholdsList = thresholds.length
      ? thresholds
          .map(
            (threshold, index) => `
                <div class="threshold-row" data-threshold-index="${index}">
                  <ha-textfield
                    label="Wert"
                    type="number"
                    min="0"
                    step="1"
                    data-threshold-field="value"
                    data-threshold-index="${index}"
                    value="${threshold.value ?? ''}"
                  ></ha-textfield>
                  <ha-textfield
                    label="Farbe (#RRGGBB)"
                    data-threshold-field="color"
                    data-threshold-index="${index}"
                    value="${threshold.color ?? ''}"
                  ></ha-textfield>
                  <ha-icon-button
                    aria-label="Schwelle entfernen"
                    class="remove-threshold"
                    data-threshold-index="${index}"
                    icon="mdi:delete"
                  ></ha-icon-button>
                </div>
              `
          )
          .join('')
      : '<p class="threshold-empty">Keine Schwellenwerte definiert.</p>';

    const removeThresholdDisabled = thresholds.length === 0 ? 'disabled' : '';

    const appearanceTab = `
      <div class="toggle-grid">
        <ha-formfield label="Aktuellen Wert anzeigen">
          <ha-switch
            data-field="show_current"
            ${this._config.show_current !== false ? 'checked' : ''}
          ></ha-switch>
        </ha-formfield>
        <ha-formfield label="Beschriftungen anzeigen">
          <ha-switch
            data-field="show_labels"
            ${this._config.show_labels !== false ? 'checked' : ''}
          ></ha-switch>
        </ha-formfield>
        <ha-formfield label="Min/Max anzeigen">
          <ha-switch
            data-field="show_min_max"
            ${this._config.show_min_max !== false ? 'checked' : ''}
          ></ha-switch>
        </ha-formfield>
        <ha-formfield label="Icons anzeigen">
          <ha-switch
            data-field="show_icons"
            ${this._config.show_icons !== false ? 'checked' : ''}
          ></ha-switch>
        </ha-formfield>
        <ha-formfield label="Kompakte Darstellung">
          <ha-switch
            data-field="compact"
            ${this._config.compact === true ? 'checked' : ''}
          ></ha-switch>
        </ha-formfield>
      </div>
      <div class="thresholds-section">
        <h3>Schwellenwerte</h3>
        <p class="threshold-description">Definiere Werte und Farben für die farbliche Darstellung.</p>
        <div class="threshold-list">
          ${thresholdsList}
        </div>
        <div class="threshold-actions">
          <mwc-button class="add-threshold" outlined>
            <ha-icon slot="icon" icon="mdi:plus"></ha-icon>
            Schwelle hinzufügen
          </mwc-button>
          <mwc-button class="remove-threshold-action" data-remove-action="remove-last" ${removeThresholdDisabled}>
            <ha-icon slot="icon" icon="mdi:delete"></ha-icon>
            Letzte Schwelle entfernen
          </mwc-button>
          <mwc-button class="reset-thresholds">
            <ha-icon slot="icon" icon="mdi:restore"></ha-icon>
            Standardwerte
          </mwc-button>
        </div>
      </div>
    `;

    const supportsEntityPicker = customElements.get('ha-entity-picker') !== undefined;
    if (!supportsEntityPicker && !this._waitingForEntityPicker) {
      this._waitingForEntityPicker = true;
      customElements.whenDefined('ha-entity-picker').then(() => {
        this._waitingForEntityPicker = false;
        if (this.isConnected) {
          this.render();
        }
      });
    }

    const entitiesTab = `
      <div class="entities">
        ${this._entities
          .map((entity, index) => {
            const showLabels = entity.show_labels === undefined ? 'inherit' : entity.show_labels ? 'true' : 'false';
            const showMinMax = entity.show_min_max === undefined ? 'inherit' : entity.show_min_max ? 'true' : 'false';
            const showCurrent = entity.show_current === undefined ? 'inherit' : entity.show_current ? 'true' : 'false';
            const showIcons = entity.show_icons === undefined ? 'inherit' : entity.show_icons ? 'true' : 'false';
            return `
              <div class="entity-card" data-index="${index}">
                <div class="entity-header">
                  <span>Entität ${index + 1}</span>
                  <mwc-button
                    class="remove-entity"
                    data-entity-index="${index}"
                    dense
                  >
                    <ha-icon slot="icon" icon="mdi:delete"></ha-icon>
                    Entfernen
                  </mwc-button>
                </div>
                <div class="entity-grid">
                  ${supportsEntityPicker
                    ? `
                        <ha-entity-picker
                          label="Entität"
                          value="${entity.entity ?? ''}"
                          data-field="entity"
                          data-entity-index="${index}"
                          allow-custom-entity
                        ></ha-entity-picker>
                      `
                    : `
                        <ha-textfield
                          label="Entität"
                          data-field="entity"
                          data-entity-index="${index}"
                          value="${entity.entity ?? ''}"
                        ></ha-textfield>
                      `}
                  <ha-textfield
                    label="Name"
                    data-field="name"
                    data-entity-index="${index}"
                    value="${entity.name ?? ''}"
                  ></ha-textfield>
                  <ha-textfield
                    label="Icon (z. B. mdi:thermometer)"
                    data-field="icon"
                    data-entity-index="${index}"
                    value="${entity.icon ?? ''}"
                  ></ha-textfield>
                  <ha-textfield
                    label="Stunden"
                    type="number"
                    min="1"
                    step="1"
                    data-field="hours"
                    data-entity-index="${index}"
                    value="${entity.hours ?? ''}"
                  ></ha-textfield>
                  <ha-textfield
                    label="Intervalle"
                    type="number"
                    min="1"
                    step="1"
                    data-field="intervals"
                    data-entity-index="${index}"
                    value="${entity.intervals ?? ''}"
                  ></ha-textfield>
                  <ha-select
                    label="Beschriftungen"
                    data-field="show_labels"
                    data-entity-index="${index}"
                    data-value="${showLabels}"
                  >
                    <mwc-list-item value="inherit">Von Karte übernehmen</mwc-list-item>
                    <mwc-list-item value="true">Anzeigen</mwc-list-item>
                    <mwc-list-item value="false">Ausblenden</mwc-list-item>
                  </ha-select>
                  <ha-select
                    label="Min/Max"
                    data-field="show_min_max"
                    data-entity-index="${index}"
                    data-value="${showMinMax}"
                  >
                    <mwc-list-item value="inherit">Von Karte übernehmen</mwc-list-item>
                    <mwc-list-item value="true">Anzeigen</mwc-list-item>
                    <mwc-list-item value="false">Ausblenden</mwc-list-item>
                  </ha-select>
                  <ha-select
                    label="Aktueller Wert"
                    data-field="show_current"
                    data-entity-index="${index}"
                    data-value="${showCurrent}"
                  >
                    <mwc-list-item value="inherit">Von Karte übernehmen</mwc-list-item>
                    <mwc-list-item value="true">Anzeigen</mwc-list-item>
                    <mwc-list-item value="false">Ausblenden</mwc-list-item>
                  </ha-select>
                  <ha-select
                    label="Icon"
                    data-field="show_icons"
                    data-entity-index="${index}"
                    data-value="${showIcons}"
                  >
                    <mwc-list-item value="inherit">Von Karte übernehmen</mwc-list-item>
                    <mwc-list-item value="true">Anzeigen</mwc-list-item>
                    <mwc-list-item value="false">Ausblenden</mwc-list-item>
                  </ha-select>
                </div>
              </div>
            `;
          })
          .join('')}
        <mwc-button class="add-entity" outlined>
          <ha-icon slot="icon" icon="mdi:plus"></ha-icon>
          Entität hinzufügen
        </mwc-button>
      </div>
    `;

    const tabContent = [generalTab, appearanceTab, entitiesTab][this._selectedTab] || generalTab;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          padding: 16px;
          color: var(--primary-text-color);
        }
        .tab-bar {
          display: flex;
          gap: 4px;
          border-bottom: 1px solid var(--divider-color);
          margin: 0 -16px 16px;
          padding: 0 16px;
        }
        .tab-bar button {
          position: relative;
          border: none;
          background: none;
          cursor: pointer;
          padding: 12px 16px;
          margin: 0;
          font: inherit;
          color: var(--secondary-text-color);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          font-weight: 600;
          transition: color 0.2s ease;
        }
        .tab-bar button::after {
          content: '';
          position: absolute;
          left: 12px;
          right: 12px;
          bottom: 0;
          height: 2px;
          background: transparent;
          transform: scaleX(0);
          transform-origin: center;
          transition: transform 0.2s ease, background 0.2s ease;
        }
        .tab-bar button.active {
          color: var(--primary-color);
        }
        .tab-bar button.active::after {
          background: var(--primary-color);
          transform: scaleX(1);
        }
        .tab-bar button:focus-visible {
          outline: none;
          box-shadow: 0 0 0 2px var(--primary-color);
          border-radius: 6px;
        }
        .tab-bar button:hover:not(.active) {
          color: var(--primary-text-color);
        }
        .form-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 16px;
        }
        .toggle-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 16px;
        }
        .thresholds-section {
          margin-top: 24px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .thresholds-section h3 {
          margin: 0;
          font-size: 1rem;
          font-weight: 600;
        }
        .threshold-description {
          margin: 0;
          color: var(--secondary-text-color);
          font-size: 0.9rem;
        }
        .threshold-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .threshold-row {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)) auto;
          gap: 12px;
          align-items: end;
        }
        .threshold-row ha-textfield {
          width: 100%;
        }
        .threshold-empty {
          margin: 0;
          color: var(--secondary-text-color);
          font-style: italic;
        }
        .threshold-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .threshold-actions mwc-button.remove-threshold-action {
          --mdc-theme-primary: var(--error-color, #db4437);
        }
        .entities {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .entity-card {
          border-radius: 12px;
          border: 1px solid var(--divider-color);
          padding: 16px;
          background: var(--card-background-color, var(--ha-card-background, #fff));
          box-shadow: var(--ha-card-box-shadow, none);
        }
        .entity-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 12px;
        }
        .entity-header mwc-button.remove-entity {
          --mdc-theme-primary: var(--error-color, #db4437);
        }
        .entity-grid {
          display: grid;
          gap: 12px;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        }
        mwc-button.add-entity {
          align-self: flex-start;
        }
      </style>
      <div class="tab-bar" role="tablist" aria-label="Karteneinstellungen">
        ${tabs
          .map(
            (label, index) => `
              <button
                type="button"
                class="tab ${index === this._selectedTab ? 'active' : ''}"
                data-index="${index}"
                role="tab"
                aria-selected="${index === this._selectedTab}"
                tabindex="${index === this._selectedTab ? '0' : '-1'}"
              >${label}</button>
            `
          )
          .join('')}
      </div>
      <div class="tab-content">${tabContent}</div>
    `;

    this.shadowRoot.querySelectorAll('.tab-bar button').forEach((tab) => {
      tab.addEventListener('click', () => {
        const index = Number(tab.dataset.index || 0);
        if (index !== this._selectedTab) {
          this._setSelectedTab(index);
        }
      });

      tab.addEventListener('keydown', (ev) => {
        const key = ev.key;
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
          return;
        }

        ev.preventDefault();
        const tabCount = tabs.length;
        let nextIndex = this._selectedTab;

        if (key === 'ArrowLeft') {
          nextIndex = (this._selectedTab - 1 + tabCount) % tabCount;
        } else if (key === 'ArrowRight') {
          nextIndex = (this._selectedTab + 1) % tabCount;
        } else if (key === 'Home') {
          nextIndex = 0;
        } else if (key === 'End') {
          nextIndex = tabCount - 1;
        }

        if (nextIndex !== this._selectedTab) {
          this._setSelectedTab(nextIndex);
        }
      });
    });

    if (this._shouldFocusSelectedTab) {
      const activeTab = this.shadowRoot.querySelector('.tab-bar button.active');
      if (activeTab) {
        activeTab.focus();
      }
      this._shouldFocusSelectedTab = false;
    }

    this.shadowRoot.querySelectorAll('ha-textfield[data-field]').forEach((input) => {
      const handler = (ev) => this._valueChanged(ev);
      input.addEventListener('input', handler);
      input.addEventListener('change', handler);
    });

    this.shadowRoot.querySelectorAll('ha-switch[data-field]').forEach((toggle) => {
      toggle.addEventListener('change', (ev) => this._valueChanged(ev));
    });

    this.shadowRoot.querySelectorAll('ha-select[data-field]').forEach((select) => {
      if (select.dataset.value !== undefined) {
        select.value = select.dataset.value;
      }
      select.addEventListener('selected', (ev) => this._valueChanged(ev));
      select.addEventListener('closed', (ev) => this._valueChanged(ev));
      select.addEventListener('value-changed', (ev) => this._valueChanged(ev));
    });

    this.shadowRoot.querySelectorAll('ha-textfield[data-threshold-field]').forEach((input) => {
      const handler = (ev) => this._thresholdInputChanged(ev);
      input.addEventListener('input', handler);
      input.addEventListener('change', handler);
    });

    this.shadowRoot.querySelectorAll('ha-entity-picker[data-field="entity"]').forEach((picker) => {
      if (this._hass) {
        picker.hass = this._hass;
      }
      if (picker.hasAttribute('value')) {
        picker.value = picker.getAttribute('value');
      }
      picker.addEventListener('value-changed', (ev) => this._entityPickerChanged(ev));
    });

    const addButton = this.shadowRoot.querySelector('.add-entity');
    if (addButton) {
      addButton.addEventListener('click', () => this._addEntity());
    }

    const addThresholdButton = this.shadowRoot.querySelector('.add-threshold');
    if (addThresholdButton) {
      addThresholdButton.addEventListener('click', () => this._addThreshold());
    }

    const removeThresholdActionButton = this.shadowRoot.querySelector('.remove-threshold-action');
    if (removeThresholdActionButton) {
      removeThresholdActionButton.addEventListener('click', (ev) => this._removeThreshold(ev));
    }

    const resetThresholdsButton = this.shadowRoot.querySelector('.reset-thresholds');
    if (resetThresholdsButton) {
      resetThresholdsButton.addEventListener('click', () => this._resetThresholds());
    }

    this.shadowRoot.querySelectorAll('.remove-threshold').forEach((button) => {
      button.addEventListener('click', (ev) => this._removeThreshold(ev));
    });

    this.shadowRoot.querySelectorAll('.remove-entity').forEach((button) => {
      button.addEventListener('click', (ev) => this._removeEntity(ev));
    });

    this._hasRendered = true;
  }

  _entityPickerChanged(ev) {
    const target = ev.target;
    if (!target || target.dataset.entityIndex === undefined) {
      return;
    }
    const index = Number(target.dataset.entityIndex);
    const value = ev.detail?.value || target.value || '';
    const entities = [...this._entities];
    const updated = { ...entities[index], entity: value };
    entities[index] = updated;
    this._config = { ...this._config, entities };
    this._updateConfig();
  }

  _valueChanged(ev) {
    const target = ev.target;
    if (!target || !target.dataset) return;

    const field = target.dataset.field;
    if (!field) return;

    let value;
    if (target.localName === 'ha-switch') {
      value = target.checked;
    } else if (target.localName === 'ha-select') {
      const selectValue = target.value ?? target.dataset.value;
      value = selectValue;
      if (value === undefined && ev.detail && 'value' in ev.detail) {
        value = ev.detail.value;
      }
    } else if (target.type === 'number') {
      value = target.value === '' ? undefined : Number(target.value);
    } else {
      value = target.value;
    }

    if (target.dataset.entityIndex !== undefined) {
      const index = Number(target.dataset.entityIndex);
      const entities = [...this._entities];
      const updated = { ...entities[index] };

      if (target.localName === 'ha-select') {
        if (value === 'inherit') {
          delete updated[field];
        } else if (value === 'true' || value === true) {
          updated[field] = true;
        } else if (value === 'false' || value === false) {
          updated[field] = false;
        }
      } else if (value === '' || value === undefined || (Number.isNaN(value) && target.type === 'number')) {
        delete updated[field];
      } else {
        updated[field] = value;
      }

      entities[index] = updated;
      this._config = { ...this._config, entities };
    } else {
      const updatedConfig = { ...this._config };

      if (target.localName === 'ha-switch') {
        updatedConfig[field] = value;
      } else if (target.localName === 'ha-select') {
        updatedConfig[field] = value;
      } else if (value === '' || value === undefined || (Number.isNaN(value) && target.type === 'number')) {
        delete updatedConfig[field];
      } else {
        updatedConfig[field] = value;
      }

      this._config = updatedConfig;
    }

    this._updateConfig();
  }

  _thresholdInputChanged(ev) {
    const target = ev.target;
    if (!target) return;

    const indexAttr = target.dataset.thresholdIndex;
    if (indexAttr === undefined) return;
    const index = Number(indexAttr);
    if (Number.isNaN(index)) return;

    const field = target.dataset.thresholdField;
    if (!field) return;

    const thresholds = Array.isArray(this._config.thresholds)
      ? this._config.thresholds.map((threshold) => ({ ...threshold }))
      : [];

    while (thresholds.length <= index) {
      thresholds.push({});
    }

    const updated = { ...thresholds[index] };

    if (field === 'value') {
      const value = target.value === '' ? undefined : Number(target.value);
      if (value === undefined || Number.isNaN(value)) {
        delete updated.value;
      } else {
        updated.value = value;
      }
    } else if (field === 'color') {
      const color = (target.value || '').trim();
      if (color === '') {
        delete updated.color;
      } else {
        updated.color = color;
      }
    }

    thresholds[index] = updated;

    const cleaned = thresholds.filter((threshold) => Object.keys(threshold).length > 0);
    const updatedConfig = { ...this._config };

    if (cleaned.length) {
      updatedConfig.thresholds = cleaned;
    } else {
      delete updatedConfig.thresholds;
    }

    const shouldRerender = cleaned.length !== thresholds.length;

    this._config = updatedConfig;

    if (shouldRerender) {
      this.render();
      this._updateConfig();
      return;
    }

    this._updateConfig();
  }

  _addThreshold() {
    const thresholds = Array.isArray(this._config.thresholds)
      ? this._config.thresholds.map((threshold) => ({ ...threshold }))
      : [];

    const lastThreshold = thresholds[thresholds.length - 1];
    const nextValue = typeof lastThreshold?.value === 'number' ? lastThreshold.value + 5 : 0;
    const nextColor = lastThreshold?.color || threshold_default_number[0].color;

    thresholds.push({ value: nextValue, color: nextColor });

    this._config = { ...this._config, thresholds };
    this.render();
    this._updateConfig();
  }

  _removeThreshold(ev) {
    const thresholdsSource = Array.isArray(this._config.thresholds)
      ? this._config.thresholds
      : [];

    let index = Number(ev?.currentTarget?.dataset?.thresholdIndex ?? ev?.target?.dataset?.thresholdIndex);
    if (Number.isNaN(index)) {
      const action = ev?.currentTarget?.dataset?.removeAction ?? ev?.target?.dataset?.removeAction;
      if (action === 'remove-last') {
        index = thresholdsSource.length - 1;
      }
    }

    if (Number.isNaN(index) || index < 0 || index >= thresholdsSource.length) {
      return;
    }

    const thresholds = thresholdsSource.filter((_, i) => i !== index);

    const updatedConfig = { ...this._config };
    if (thresholds.length) {
      updatedConfig.thresholds = thresholds;
    } else {
      delete updatedConfig.thresholds;
    }

    this._config = updatedConfig;
    this.render();
    this._updateConfig();
  }

  _resetThresholds() {
    const thresholds = threshold_default_number.map((threshold) => ({ ...threshold }));
    this._config = { ...this._config, thresholds };
    this.render();
    this._updateConfig();
  }

  _addEntity() {
    const entities = [...this._entities, { entity: '' }];
    this._config = { ...this._config, entities };
    this._setSelectedTab(2);
    this._updateConfig();
  }

  _removeEntity(ev) {
    const index = Number(ev.currentTarget?.dataset?.entityIndex);
    if (Number.isNaN(index)) {
      return;
    }
    const entities = this._entities.filter((_, i) => i !== index);
    this._config = { ...this._config, entities };
    this.render();
    this._updateConfig();
  }

  _setSelectedTab(index) {
    this._selectedTab = index;
    this._shouldFocusSelectedTab = true;
    this.render();
  }

  _updateConfig() {
    const cleanedEntities = this._entities.map((entity) => {
      const cleaned = { ...entity };
      Object.keys(cleaned).forEach((key) => {
        if (cleaned[key] === '' || cleaned[key] === undefined) {
          delete cleaned[key];
        }
      });
      return cleaned;
    });

    const config = {
      ...this._config,
      entities: cleanedEntities,
    };

    this._lastConfigString = this._stringifyConfig(config);

    this.dispatchEvent(
      new CustomEvent('config-changed', {
        detail: { config },
        bubbles: true,
        composed: true,
      })
    );
  }
}

if (!customElements.get('waterfall-history-card-editor')) {
  customElements.define('waterfall-history-card-editor', WaterfallHistoryCardEditor);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'waterfall-history-card',
  name: 'waterfall History Card',
  description: 'A horizontal waterfall display for historical sensor data'
});

console.info(
  `%c waterFALL-HISTORY-CARD %c v2.0 `,
  'color: orange; font-weight: bold; background: black',
  'color: white; font-weight: bold; background: dimgray'
);
