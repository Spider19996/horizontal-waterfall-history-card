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

const fireEvent = (node, type, detail, options) => {
  const event = new Event(type, {
    bubbles: options?.bubbles ?? true,
    cancelable: options?.cancelable ?? false,
    composed: options?.composed ?? true,
  });
  event.detail = detail;
  node.dispatchEvent(event);
  return event;
};


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
      },
      fr: {
        history: 'Historique',
        error_loading_data: 'Erreur lors du chargement des données historiques',
        min_label: 'Min',
        max_label: 'Max',
        hours_ago: 'h',
        minutes_ago: 'min',
        now: 'Actuel',
      }
    };

    this.language = 'en';
    this.t = (key) => (this.translations[this.language] && this.translations[this.language][key]) || this.translations.en[key] || key;
  }

  setConfig(config) {
    // FIX: ensure config object exists before accessing properties
    this.config = this.config || {};
    // FIX: add show_icons option (default true)
    this.config.show_icons = (config.show_icons !== false);

    if (!config.entities || !Array.isArray(config.entities) || config.entities.length === 0) {
      throw new Error('Please define a list of entities.');
    }

    const globalConfig = {
        title: config.title || this.t('history'),
        hours: config.hours || 24,
        intervals: config.intervals || 48,
        height: config.height || 60,
        min_value: config.min_value || null,
        max_value: config.max_value || null,
        thresholds: config.thresholds || null,
        gradient: config.gradient || false,
        show_current: config.show_current !== false,
        show_labels: config.show_labels !== false,
        show_min_max: config.show_min_max || false,
        unit: config.unit || null,
        icon: config.icon || null,
        compact: config.compact || false,
        default_value: config.default_value ?? null,
        digits: typeof config.digits === 'number' ? config.digits : 1,
        card_mod: config.card_mod || {},
    };

    this.config = {
        ...globalConfig,
        entities: config.entities.map(entityConfig => {
            if (typeof entityConfig === 'string') {
                return { entity: entityConfig };
            }
            return entityConfig;
        }),
    };
  }

  set hass(hass) {
    this._hass = hass;
    if (hass.language) {
      this.language = hass.language.split('-')[0];
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
        let icon = null;
        if (entity.attributes && entity.attributes.icon) {
          icon = entity.attributes.icon;
        } else {
          const domain = entityId.split('.')[0];
          icon = this.DEFAULT_DOMAIN_ICONS[domain] || 'mdi:bookmark';
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

  static getConfigElement() {
    return document.createElement('waterfall-history-card-editor');
  }
}

customElements.define('waterfall-history-card', waterfallHistoryCard);

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

const registerWaterfallHistoryCardEditor = () => {
  if (customElements.get('waterfall-history-card-editor')) {
    return true;
  }

  const litLib = window.litElement || window.Lit || {};
  const LitElementBase = litLib.LitElement || window.LitElement;
  const html = litLib.html || window.html;
  const css = litLib.css || window.css;

  if (!LitElementBase || !html || !css) {
    return false;
  }

  class WaterfallHistoryCardEditor extends LitElementBase {
    static get properties() {
      return {
        hass: {},
        _config: { type: Object },
        _activeTab: { type: String },
      };
    }

    constructor() {
      super();
      this._config = {};
      this._activeTab = 'general';
    }

    setConfig(config) {
      const safeConfig = config && typeof config === 'object' ? config : {};
      this._config = {
        title: 'History',
        hours: 24,
        intervals: 48,
        height: 60,
        show_labels: true,
        show_min_max: false,
        show_current: true,
        show_icons: true,
        compact: false,
        gradient: false,
        digits: 1,
        ...safeConfig,
        entities: (safeConfig.entities || []).map((entity) =>
          typeof entity === 'string' ? { entity } : { ...entity }
        ),
        thresholds: Array.isArray(safeConfig.thresholds)
          ? safeConfig.thresholds.map((item) => ({ ...item }))
          : safeConfig.thresholds === null
            ? null
            : undefined,
      };
      this.requestUpdate();
    }

    get _thresholds() {
      if (Array.isArray(this._config.thresholds)) {
        return this._config.thresholds;
      }
      return undefined;
    }

    render() {
      if (!html || !css) {
        return null;
      }

      return html`
        <div class="editor">
          <ha-tabs
            scrollable
            .selected=${['general', 'entities', 'thresholds'].indexOf(this._activeTab)}
            @iron-activate=${this._handleTabActivated}
          >
            <paper-tab name="general">${this._localize('ui.dialogs.helper_settings.tabs.settings', 'Settings')}</paper-tab>
            <paper-tab name="entities">${this._localize('ui.dialogs.helper_settings.tabs.entities', 'Entities')}</paper-tab>
            <paper-tab name="thresholds">${this._localize('ui.components.history_graph.options.thresholds', 'Thresholds')}</paper-tab>
          </ha-tabs>
          <div class="content">
            ${this._activeTab === 'general' ? this._renderGeneralTab() : ''}
            ${this._activeTab === 'entities' ? this._renderEntitiesTab() : ''}
            ${this._activeTab === 'thresholds' ? this._renderThresholdTab() : ''}
          </div>
        </div>
      `;
    }

    _renderGeneralTab() {
      return html`
        <div class="form-grid">
          <ha-textfield
            label="${this._localize('ui.panel.lovelace.editor.card.generic.title')}"
            .value=${this._config.title ?? ''}
            @input=${(ev) => this._updateConfigValue('title', ev.target.value)}
          ></ha-textfield>
          <ha-textfield
            type="number"
            label="${this._localize('ui.panel.lovelace.editor.card.generic.hours', 'Hours')}"
            .value=${this._config.hours ?? ''}
            min="1"
            @input=${(ev) => this._updateNumericConfigValue('hours', ev.target.value)}
          ></ha-textfield>
          <ha-textfield
            type="number"
            label="${this._localize('ui.components.history_graph.options.periods', 'Intervals')}"
            .value=${this._config.intervals ?? ''}
            min="1"
            @input=${(ev) => this._updateNumericConfigValue('intervals', ev.target.value)}
          ></ha-textfield>
          <ha-textfield
            type="number"
            label="${this._localize('ui.components.history_graph.options.graph_height', 'Bar height (px)')}"
            .value=${this._config.height ?? ''}
            min="10"
            @input=${(ev) => this._updateNumericConfigValue('height', ev.target.value)}
          ></ha-textfield>
          <ha-textfield
            type="number"
            label="${this._localize('ui.panel.lovelace.editor.card.generic.minimum', 'Min value')}"
            .value=${this._config.min_value ?? ''}
            @input=${(ev) => this._updateOptionalNumericValue('min_value', ev.target.value)}
          ></ha-textfield>
          <ha-textfield
            type="number"
            label="${this._localize('ui.panel.lovelace.editor.card.generic.maximum', 'Max value')}"
            .value=${this._config.max_value ?? ''}
            @input=${(ev) => this._updateOptionalNumericValue('max_value', ev.target.value)}
          ></ha-textfield>
          <ha-textfield
            label="${this._localize('ui.panel.lovelace.editor.card.generic.unit_of_measurement')}"
            .value=${this._config.unit ?? ''}
            @input=${(ev) => this._updateConfigValue('unit', ev.target.value)}
          ></ha-textfield>
          <ha-textfield
            type="number"
            label="${this._localize('ui.panel.lovelace.editor.card.generic.decimals', 'Digits')}"
            .value=${this._config.digits ?? ''}
            min="0"
            max="6"
            @input=${(ev) => this._updateNumericConfigValue('digits', ev.target.value)}
          ></ha-textfield>
          <ha-textfield
            label="${this._localize('ui.components.history_graph.options.default_value', 'Default value')}"
            .value=${this._config.default_value ?? ''}
            @input=${(ev) => this._updateOptionalNumericValue('default_value', ev.target.value)}
          ></ha-textfield>
          <ha-textfield
            label="${this._localize('ui.panel.lovelace.editor.card.generic.icon')}"
            .value=${this._config.icon ?? ''}
            @input=${(ev) => this._updateConfigValue('icon', ev.target.value)}
          ></ha-textfield>
        </div>
        <div class="toggles">
          ${this._renderToggleRow('show_labels', this._localize('ui.panel.lovelace.editor.card.generic.show_labels'))}
          ${this._renderToggleRow('show_min_max', this._localize('ui.components.history_graph.options.show_extrema', 'Show min/max'))}
          ${this._renderToggleRow('show_current', this._localize('ui.panel.lovelace.editor.card.generic.show_current', 'Show current value'))}
          ${this._renderToggleRow('show_icons', this._localize('ui.panel.lovelace.editor.card.generic.show_icon', 'Show icons'))}
          ${this._renderToggleRow('compact', this._localize('ui.panel.lovelace.editor.card.generic.compact_view', 'Compact'))}
          ${this._renderToggleRow('gradient', this._localize('ui.panel.lovelace.editor.card.generic.gradient', 'Use gradient colors'))}
        </div>
      `;
    }

    _renderToggleRow(key, label) {
      return html`
        <ha-settings-row>
          <span slot="heading">${label}</span>
          <ha-switch
            slot="content"
            .checked=${this._config[key] ?? false}
            @change=${(ev) => this._updateConfigValue(key, ev.target.checked)}
          ></ha-switch>
        </ha-settings-row>
      `;
    }

    _renderEntitiesTab() {
      const entities = this._config.entities || [];
      return html`
        <div class="entities">
          ${entities.length === 0
            ? html`<p class="hint">${this._localize('ui.panel.lovelace.editor.card.generic.no_entities')}</p>`
            : entities.map((entity, index) => this._renderEntityEditor(entity, index))}
          <div class="actions">
            <mwc-button raised @click=${this._addEntity}>
              ${this._localize('ui.panel.lovelace.editor.card.generic.add_entity')}
            </mwc-button>
          </div>
        </div>
      `;
    }

    _renderEntityEditor(entity, index) {
      return html`
        <ha-card outlined>
          <div class="entity-grid">
            <ha-entity-picker
              .hass=${this.hass}
              .value=${entity.entity || ''}
              required
              allow-custom-entity
              @value-changed=${(ev) => this._updateEntityValue(index, 'entity', ev.detail.value)}
            ></ha-entity-picker>
            <ha-textfield
              label="${this._localize('ui.panel.lovelace.editor.card.generic.name')}"
              .value=${entity.name ?? ''}
              @input=${(ev) => this._updateEntityValue(index, 'name', ev.target.value)}
            ></ha-textfield>
            <ha-textfield
              type="number"
              label="${this._localize('ui.panel.lovelace.editor.card.generic.hours', 'Hours')}"
              .value=${entity.hours ?? ''}
              min="1"
              @input=${(ev) => this._updateEntityNumericValue(index, 'hours', ev.target.value)}
            ></ha-textfield>
            <ha-textfield
              type="number"
              label="${this._localize('ui.components.history_graph.options.periods', 'Intervals')}"
              .value=${entity.intervals ?? ''}
              min="1"
              @input=${(ev) => this._updateEntityNumericValue(index, 'intervals', ev.target.value)}
            ></ha-textfield>
            <ha-select
              label="${this._localize('ui.panel.lovelace.editor.card.generic.show_labels')}"
              .value=${this._triStateValue(entity.show_labels)}
              @value-changed=${(ev) => this._updateEntityTriState(index, 'show_labels', ev.detail.value)}
            >
              ${this._renderTriStateOptions()}
            </ha-select>
            <ha-select
              label="${this._localize('ui.components.history_graph.options.show_extrema', 'Show min/max')}"
              .value=${this._triStateValue(entity.show_min_max)}
              @value-changed=${(ev) => this._updateEntityTriState(index, 'show_min_max', ev.detail.value)}
            >
              ${this._renderTriStateOptions()}
            </ha-select>
            <ha-select
              label="${this._localize('ui.panel.lovelace.editor.card.generic.show_current', 'Show current value')}"
              .value=${this._triStateValue(entity.show_current)}
              @value-changed=${(ev) => this._updateEntityTriState(index, 'show_current', ev.detail.value)}
            >
              ${this._renderTriStateOptions()}
            </ha-select>
            <ha-select
              label="${this._localize('ui.panel.lovelace.editor.card.generic.show_icon', 'Show icon')}"
              .value=${this._triStateValue(entity.show_icons)}
              @value-changed=${(ev) => this._updateEntityTriState(index, 'show_icons', ev.detail.value)}
            >
              ${this._renderTriStateOptions()}
            </ha-select>
            <ha-textfield
              label="${this._localize('ui.panel.lovelace.editor.card.generic.unit_of_measurement')}"
              .value=${entity.unit ?? ''}
              @input=${(ev) => this._updateEntityValue(index, 'unit', ev.target.value)}
            ></ha-textfield>
            <ha-textfield
              label="${this._localize('ui.panel.lovelace.editor.card.generic.icon')}"
              .value=${entity.icon ?? ''}
              @input=${(ev) => this._updateEntityValue(index, 'icon', ev.target.value)}
            ></ha-textfield>
          </div>
          <div class="entity-actions">
            <mwc-button class="remove" @click=${() => this._removeEntity(index)}>
              ${this._localize('ui.common.remove')}
            </mwc-button>
          </div>
        </ha-card>
      `;
    }

    _renderThresholdTab() {
      const thresholds = this._thresholds;
      return html`
        <div class="thresholds">
          <ha-settings-row>
            <span slot="heading">${this._localize('ui.panel.lovelace.editor.card.generic.gradient', 'Use gradient colors')}</span>
            <ha-switch
              slot="content"
              .checked=${this._config.gradient ?? false}
              @change=${(ev) => this._updateConfigValue('gradient', ev.target.checked)}
            ></ha-switch>
          </ha-settings-row>
          ${Array.isArray(thresholds) && thresholds.length
            ? thresholds.map((threshold, index) => this._renderThresholdEditor(threshold, index))
            : html`<p class="hint">${this._localize('ui.components.history_graph.options.no_thresholds', 'Using built-in defaults.')}</p>`}
          <div class="actions">
            <mwc-button @click=${this._addThreshold}>${this._localize('ui.panel.lovelace.editor.card.generic.add_row', 'Add threshold')}</mwc-button>
            ${Array.isArray(thresholds) && thresholds.length
              ? html`<mwc-button @click=${this._clearThresholds}>${this._localize('ui.common.clear', 'Clear')}</mwc-button>`
              : ''}
          </div>
        </div>
      `;
    }

    _renderThresholdEditor(threshold, index) {
      return html`
        <ha-card outlined>
          <div class="threshold-grid">
            <ha-textfield
              type="number"
              label="${this._localize('ui.panel.lovelace.editor.card.generic.value')}"
              .value=${threshold.value ?? ''}
              @input=${(ev) => this._updateThresholdValue(index, 'value', ev.target.value)}
            ></ha-textfield>
            <div class="color-picker">
              <ha-textfield
                label="${this._localize('ui.panel.lovelace.editor.card.generic.color')}"
                .value=${threshold.color ?? ''}
                @input=${(ev) => this._updateThresholdValue(index, 'color', ev.target.value)}
              ></ha-textfield>
              <input
                class="color-input"
                type="color"
                .value=${this._normalizeColor(threshold.color)}
                @input=${(ev) => this._updateThresholdValue(index, 'color', ev.target.value)}
              />
            </div>
          </div>
          <div class="entity-actions">
            <mwc-button class="remove" @click=${() => this._removeThreshold(index)}>${this._localize('ui.common.remove')}</mwc-button>
          </div>
        </ha-card>
      `;
    }

    _renderTriStateOptions() {
      return html`
        <mwc-list-item value="default">${this._localize('ui.common.default', 'Default')}</mwc-list-item>
        <mwc-list-item value="true">${this._localize('ui.common.show', 'Show')}</mwc-list-item>
        <mwc-list-item value="false">${this._localize('ui.common.hide', 'Hide')}</mwc-list-item>
      `;
    }

    _triStateValue(value) {
      if (value === undefined || value === null) {
        return 'default';
      }
      return value ? 'true' : 'false';
    }

    _handleTabActivated(ev) {
      const tab = ev.detail.item?.getAttribute('name');
      if (!tab || tab === this._activeTab) return;
      this._activeTab = tab;
    }

    _updateConfigValue(key, value) {
      const newConfig = { ...this._config };
      if (value === '' || value === undefined) {
        delete newConfig[key];
      } else {
        newConfig[key] = value;
      }
      this._commitConfig(newConfig);
    }

    _updateNumericConfigValue(key, value) {
      if (value === '' || value === undefined) {
        this._updateConfigValue(key, undefined);
        return;
      }
      const num = Number(value);
      if (!Number.isNaN(num)) {
        this._updateConfigValue(key, num);
      }
    }

    _updateOptionalNumericValue(key, value) {
      if (value === '' || value === undefined) {
        this._updateConfigValue(key, undefined);
        return;
      }
      const num = Number(value);
      this._updateConfigValue(key, Number.isNaN(num) ? value : num);
    }

    _addEntity() {
      const entities = [...(this._config.entities || [])];
      entities.push({ entity: '' });
      this._commitConfig({ ...this._config, entities });
    }

    _removeEntity(index) {
      const entities = [...(this._config.entities || [])];
      entities.splice(index, 1);
      this._commitConfig({ ...this._config, entities });
    }

    _updateEntityValue(index, key, value) {
      const entities = [...(this._config.entities || [])];
      const updated = { ...entities[index] };
      if (value === '' || value === undefined) {
        delete updated[key];
      } else {
        updated[key] = value;
      }
      entities[index] = updated;
      this._commitConfig({ ...this._config, entities });
    }

    _updateEntityNumericValue(index, key, value) {
      if (value === '' || value === undefined) {
        this._updateEntityValue(index, key, undefined);
        return;
      }
      const num = Number(value);
      if (!Number.isNaN(num)) {
        this._updateEntityValue(index, key, num);
      }
    }

    _updateEntityTriState(index, key, value) {
      if (value === undefined || value === 'default') {
        this._updateEntityValue(index, key, undefined);
        return;
      }
      this._updateEntityValue(index, key, value === 'true');
    }

    _addThreshold() {
      const thresholds = Array.isArray(this._thresholds) ? [...this._thresholds] : [];
      thresholds.push({ value: thresholds.length ? thresholds[thresholds.length - 1].value : 0, color: '#000000' });
      this._commitConfig({ ...this._config, thresholds });
    }

    _removeThreshold(index) {
      const thresholds = Array.isArray(this._thresholds) ? [...this._thresholds] : [];
      thresholds.splice(index, 1);
      const next = thresholds.length ? thresholds : undefined;
      this._commitConfig({ ...this._config, thresholds: next });
    }

    _updateThresholdValue(index, key, value) {
      const thresholds = Array.isArray(this._thresholds) ? [...this._thresholds] : [];
      const updated = { ...thresholds[index] };
      if (key === 'value') {
        const num = Number(value);
        if (!Number.isNaN(num)) {
          updated.value = num;
        }
      } else if (key === 'color') {
        updated.color = this._normalizeColor(value);
      }
      thresholds[index] = updated;
      this._commitConfig({ ...this._config, thresholds });
    }

    _clearThresholds() {
      const newConfig = { ...this._config };
      delete newConfig.thresholds;
      this._commitConfig(newConfig);
    }

    _normalizeColor(value) {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^#([0-9a-fA-F]{6})$/.test(trimmed)) {
          return trimmed;
        }
        if (/^#([0-9a-fA-F]{3})$/.test(trimmed)) {
          const [, short] = trimmed.match(/^#([0-9a-fA-F]{3})$/);
          return `#${short.split('').map((c) => `${c}${c}`).join('')}`;
        }
        const cleaned = trimmed.replace(/[^0-9a-fA-F]/g, '');
        if (cleaned.length === 6) {
          return `#${cleaned}`;
        }
      }
      return '#000000';
    }

    _commitConfig(config) {
      this._config = config;
      fireEvent(this, 'config-changed', { config });
    }

    _localize(key, fallback) {
      if (!this.hass || !this.hass.localize) {
        return fallback || key;
      }
      const localized = this.hass.localize(key);
      return localized || fallback || key;
    }

    static get styles() {
      return css`
        .editor {
          display: flex;
          flex-direction: column;
        }
        ha-tabs {
          --paper-tabs-selection-bar-color: var(--primary-color);
          margin-bottom: 8px;
        }
        .content {
          display: block;
          gap: 16px;
        }
        .form-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 16px;
        }
        .toggles {
          margin-top: 16px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .entities,
        .thresholds {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .entity-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 16px;
          padding: 16px;
        }
        .threshold-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 16px;
          padding: 16px;
        }
        .color-picker {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .color-picker ha-textfield {
          flex: 1;
        }
        .color-input {
          width: 48px;
          height: 48px;
          border: none;
          background: none;
        }
        .entity-actions,
        .actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          padding: 0 16px 16px;
        }
        .hint {
          margin: 0;
          color: var(--secondary-text-color);
        }
        mwc-button.remove {
          --mdc-theme-primary: var(--error-color);
        }
      `;
    }
  }

  customElements.define('waterfall-history-card-editor', WaterfallHistoryCardEditor);
  return true;
};

if (!registerWaterfallHistoryCardEditor()) {
  let attempts = 0;
  const retryRegistration = () => {
    if (registerWaterfallHistoryCardEditor()) {
      return;
    }
    if (attempts < 5) {
      attempts += 1;
      setTimeout(retryRegistration, 1000);
    }
  };
  retryRegistration();
  window.loadCardHelpers?.().then(() => registerWaterfallHistoryCardEditor());
}
