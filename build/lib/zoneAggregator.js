/** Channel below the instance that holds one boolean per recognized name */
const SUB_LABEL_CHANNEL = 'sub_labels';
/**
 * Tracks active events per zone and maintains the active/stationary breakdown plus a summary
 * (total_objects, active) per zone. Zones are defined in Frigate config per camera.
 * The plain per-label occupancy count (`<zone>.<label>`) is intentionally NOT maintained here;
 * it comes directly from Frigate's authoritative MQTT occupancy topics. This aggregator only
 * adds the active/stationary split derived from the event stream, using each object's
 * current_zones and resetting states to 0 once the object leaves the zone or the event ends.
 *
 * The same event stream also tells who is recognized: `<zone>.sub_labels` lists the names in a zone
 * right now, and `sub_labels.<name>` is true as long as any running event carries that name.
 */
export class ZoneAggregator {
    ctx;
    /** zone → Map of eventId → TrackedEvent */
    zoneEvents = new Map();
    /** Known zone names from Frigate config */
    knownZones = new Set();
    /** zone → Set of labels for which per-label states were written, so they can be reset to 0 */
    writtenLabels = new Map();
    /** zone → value last written to `<zone>.sub_labels`, so only changes are written */
    writtenZoneSubLabels = new Map();
    /** eventId → recognized name, for every running event that has one - no matter in which zone */
    eventSubLabels = new Map();
    /** state id below `sub_labels` → value last written; an entry also means the object exists */
    subLabelStates = new Map();
    constructor(ctx) {
        this.ctx = ctx;
    }
    /**
     * The name Frigate put on an object. Frigate 0.14+ sends `[name, score]`, older versions a plain
     * string, and objects without a recognized name carry nothing or null.
     *
     * @param eventData `after` or `before` of an event message
     * @param eventData.sub_label the sub label as Frigate sent it
     */
    static getSubLabel(eventData) {
        const subLabel = Array.isArray(eventData.sub_label) ? eventData.sub_label[0] : eventData.sub_label;
        return typeof subLabel === 'string' ? subLabel.trim() : '';
    }
    /**
     * Set every `sub_labels.<name>` left from the last run to false.
     *
     * Which events are running lives in memory only, so after a restart nobody is known to be there
     * until Frigate reports the event again. Must run before the first event message arrives.
     */
    async resetSubLabels() {
        const prefix = `${this.ctx.adapter.namespace}.${SUB_LABEL_CHANNEL}.`;
        try {
            const objects = await this.ctx.adapter.getObjectViewAsync('system', 'state', {
                startkey: prefix,
                endkey: `${prefix}香`,
            });
            for (const row of objects?.rows || []) {
                const id = row.id.substring(prefix.length);
                this.subLabelStates.set(id, false);
                await this.ctx.adapter.setStateAsync(`${SUB_LABEL_CHANNEL}.${id}`, false, true);
            }
        }
        catch (error) {
            this.ctx.adapter.log.warn(`Cannot reset the recognized names: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Create `sub_labels.<name>` for names known in advance, e.g. from Frigate's face library, so
     * they exist before somebody is recognized for the first time. A name that already has its
     * state keeps it and its value - it may be recognized right now.
     *
     * @param names the names as Frigate uses them
     */
    async addKnownSubLabels(names) {
        for (const name of names) {
            const id = this.toStateId(name);
            if (!this.subLabelStates.has(id)) {
                await this.writeSubLabel(id, name, false);
            }
        }
    }
    /** Initialize zones from Frigate config and create device/state objects */
    async initZones(configData) {
        if (!configData?.cameras) {
            return;
        }
        const zones = new Set();
        for (const camKey in configData.cameras) {
            const camZones = configData.cameras[camKey].zones;
            if (camZones) {
                for (const zoneName of Object.keys(camZones)) {
                    zones.add(zoneName);
                }
            }
        }
        this.knownZones = zones;
        for (const zone of zones) {
            this.ctx.adapter.log.info(`Create zone device for: ${zone}`);
            await this.ctx.adapter.extendObjectAsync(zone, {
                type: 'device',
                common: { name: `Zone ${zone}` },
                native: {},
            });
            // Pre-create the summary states
            await this.createZoneState(`${zone}.total_objects`, `Total objects in zone ${zone}`, 'number', 'value', 0);
            await this.createZoneState(`${zone}.active`, `Objects detected in zone ${zone}`, 'boolean', 'indicator', false);
            await this.createZoneState(`${zone}.sub_labels`, `Names recognized in zone ${zone} (faces, known plates), comma separated`, 'string', 'text', '');
            // What was in the zone before a restart is unknown now; the next event fills it again
            await this.ctx.adapter.setStateAsync(`${zone}.sub_labels`, '', true);
            this.writtenZoneSubLabels.set(zone, '');
        }
    }
    /** Process an event update and recalculate zone counts */
    async processEvent(data) {
        const eventData = data.after || data.before;
        if (!eventData?.id) {
            return;
        }
        const eventId = eventData.id;
        const eventType = data.type;
        const subLabel = eventType === 'end' ? '' : ZoneAggregator.getSubLabel(eventData);
        // Recognized names count everywhere, also on cameras without zones
        await this.updateSubLabels(eventId, subLabel);
        if (this.knownZones.size === 0) {
            return;
        }
        const label = eventData.label;
        if (!label) {
            return;
        }
        // Use current_zones (zones the object currently occupies). entered_zones is cumulative
        // over the event lifetime and would keep counting an object that already left the zone.
        // An empty current_zones array is meaningful (object left all zones) and must not fall
        // back to entered_zones, so only fall back when the field is absent entirely.
        const zones = Array.isArray(eventData.current_zones) ? eventData.current_zones : eventData.entered_zones || [];
        const isStationary = eventData.stationary === true;
        if (eventType === 'end') {
            for (const [, events] of this.zoneEvents) {
                events.delete(eventId);
            }
        }
        else {
            // Remove from zones this event is no longer in
            for (const [zoneName, events] of this.zoneEvents) {
                if (!zones.includes(zoneName)) {
                    events.delete(eventId);
                }
            }
            // Add/update in current zones
            for (const zone of zones) {
                if (!this.knownZones.has(zone)) {
                    continue;
                }
                if (!this.zoneEvents.has(zone)) {
                    this.zoneEvents.set(zone, new Map());
                }
                this.zoneEvents.get(zone).set(eventId, { label, stationary: isStationary, subLabel });
            }
        }
        await this.updateZoneStates();
    }
    /**
     * Keep `sub_labels.<name>` true while any running event carries that name.
     *
     * @param eventId the event that changed
     * @param subLabel its recognized name now; '' when it has none or has ended
     */
    async updateSubLabels(eventId, subLabel) {
        if (subLabel) {
            this.eventSubLabels.set(eventId, subLabel);
        }
        else {
            this.eventSubLabels.delete(eventId);
        }
        // id → name of everybody recognized right now
        const present = new Map();
        for (const name of this.eventSubLabels.values()) {
            present.set(this.toStateId(name), name);
        }
        for (const [id, name] of present) {
            if (this.subLabelStates.get(id) !== true) {
                await this.writeSubLabel(id, name, true);
            }
        }
        for (const [id, value] of this.subLabelStates) {
            if (value && !present.has(id)) {
                await this.writeSubLabel(id, id, false);
            }
        }
    }
    /**
     * Write one `sub_labels.<name>` state, creating it on first use: when the name is found in the
     * face library, or when Frigate recognizes a name that is not in it (e.g. a known plate).
     *
     * @param id state id below the channel
     * @param name the name as Frigate sent it, used as the object name
     * @param value recognized right now
     */
    async writeSubLabel(id, name, value) {
        if (!this.subLabelStates.has(id)) {
            await this.ctx.adapter.extendObjectAsync(SUB_LABEL_CHANNEL, {
                type: 'channel',
                common: { name: 'Recognized names (faces, known plates)' },
                native: {},
            });
            await this.ctx.adapter.extendObjectAsync(`${SUB_LABEL_CHANNEL}.${id}`, {
                type: 'state',
                common: {
                    name: `${name} recognized`,
                    type: 'boolean',
                    role: 'indicator',
                    def: false,
                    read: true,
                    write: false,
                },
                native: {},
            });
        }
        this.subLabelStates.set(id, value);
        await this.ctx.adapter.setStateAsync(`${SUB_LABEL_CHANNEL}.${id}`, value, true);
    }
    /**
     * A recognized name as it may appear in a state id
     *
     * @param name the name as Frigate sent it
     */
    toStateId(name) {
        const forbidden = this.ctx.adapter.FORBIDDEN_CHARS;
        return (forbidden ? name.replace(forbidden, '_') : name).replace(/[.\s]/g, '_');
    }
    async updateZoneStates() {
        for (const zone of this.knownZones) {
            const events = this.zoneEvents.get(zone);
            // Aggregate counts: label → { total, active, stationary }
            const counts = new Map();
            let totalAll = 0;
            if (events) {
                for (const [, ev] of events) {
                    if (!counts.has(ev.label)) {
                        counts.set(ev.label, { total: 0, active: 0, stationary: 0 });
                    }
                    const c = counts.get(ev.label);
                    c.total++;
                    totalAll++;
                    if (ev.stationary) {
                        c.stationary++;
                    }
                    else {
                        c.active++;
                    }
                }
            }
            // Write per-label states. The plain `${zone}.${label}` count is intentionally NOT
            // written here: it is owned by the MQTT occupancy topic (frigate/<zone>/<label>),
            // which Frigate keeps authoritative. The aggregator only adds the active/stationary split.
            for (const [label, c] of counts) {
                await this.createZoneState(`${zone}.${label}_active`, `${label} actively moving in zone ${zone}`, 'number', 'value', 0);
                await this.ctx.adapter.setStateAsync(`${zone}.${label}_active`, c.active, true);
                await this.createZoneState(`${zone}.${label}_stationary`, `${label} stationary in zone ${zone}`, 'number', 'value', 0);
                await this.ctx.adapter.setStateAsync(`${zone}.${label}_stationary`, c.stationary, true);
            }
            // Reset states for labels that were written before but are no longer present in the zone.
            const previousLabels = this.writtenLabels.get(zone);
            if (previousLabels) {
                for (const label of previousLabels) {
                    if (!counts.has(label)) {
                        await this.ctx.adapter.setStateAsync(`${zone}.${label}_active`, 0, true);
                        await this.ctx.adapter.setStateAsync(`${zone}.${label}_stationary`, 0, true);
                    }
                }
            }
            this.writtenLabels.set(zone, new Set(counts.keys()));
            // Write summary states
            await this.ctx.adapter.setStateAsync(`${zone}.total_objects`, totalAll, true);
            await this.ctx.adapter.setStateAsync(`${zone}.active`, totalAll > 0, true);
            // Names recognized in the zone right now. Only a change is written, so a script
            // triggered by this state runs when somebody comes or goes, not on every event update.
            const names = new Set();
            for (const [, ev] of events || []) {
                if (ev.subLabel) {
                    names.add(ev.subLabel);
                }
            }
            const subLabels = [...names].sort((a, b) => a.localeCompare(b)).join(', ');
            if (this.writtenZoneSubLabels.get(zone) !== subLabels) {
                this.writtenZoneSubLabels.set(zone, subLabels);
                await this.ctx.adapter.setStateAsync(`${zone}.sub_labels`, subLabels, true);
            }
        }
    }
    async createZoneState(id, name, type, role, def) {
        await this.ctx.adapter.extendObjectAsync(id, {
            type: 'state',
            common: {
                name,
                type,
                role,
                def,
                read: true,
                write: false,
            },
            native: {},
        });
    }
}
//# sourceMappingURL=zoneAggregator.js.map