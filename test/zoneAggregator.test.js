import assert from 'node:assert';
import { ZoneAggregator } from '../build/lib/zoneAggregator.js';
import { fetchFaceNames } from '../build/lib/eventHistory.js';

/**
 * Just enough of an adapter for the aggregator: objects and states land in plain maps,
 * and every setState is recorded so tests can check that only changes are written.
 *
 * @param existingStates ids (without namespace) of state objects left from an earlier run
 */
function createAdapter(existingStates = []) {
    const objects = {};
    const states = {};
    const writes = [];
    for (const id of existingStates) {
        objects[id] = { type: 'state' };
        states[id] = true;
    }
    return {
        namespace: 'frigate.0',
        FORBIDDEN_CHARS: /[^._\-/ :!#$%&()+=@^{}|~\p{Ll}\p{Lu}\p{Nd}]+/gu,
        config: {},
        log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
        objects,
        states,
        writes,
        extendObjectAsync: async (id, obj) => {
            objects[id] = { ...objects[id], ...obj };
        },
        setStateAsync: async (id, val) => {
            states[id] = val;
            writes.push(id);
        },
        getObjectViewAsync: async (_design, _search, { startkey, endkey }) => ({
            rows: Object.keys(objects)
                .map(id => `frigate.0.${id}`)
                .filter(id => id >= startkey && id <= endkey && objects[id.substring(10)].type === 'state')
                .map(id => ({ id, value: objects[id.substring(10)] })),
        }),
    };
}

function event(type, id, fields) {
    return { type, after: { id, label: 'person', ...fields } };
}

const FRIGATE_CONFIG = { cameras: { haustuer: { zones: { haustuer_zone: {}, garten: {} } } } };

describe('ZoneAggregator.getSubLabel', () => {
    it('reads the name of the [name, score] form of Frigate 0.14+', () => {
        assert.strictEqual(ZoneAggregator.getSubLabel({ sub_label: ['Daven', 0.87] }), 'Daven');
    });

    it('reads the plain string of older Frigate versions', () => {
        assert.strictEqual(ZoneAggregator.getSubLabel({ sub_label: 'Daven' }), 'Daven');
    });

    it('returns an empty string without a recognized name', () => {
        assert.strictEqual(ZoneAggregator.getSubLabel({ sub_label: null }), '');
        assert.strictEqual(ZoneAggregator.getSubLabel({}), '');
    });
});

describe('Recognized names (sub_labels.<name>)', () => {
    it('is true while the event runs and false once it ends', async () => {
        const adapter = createAdapter();
        const aggregator = new ZoneAggregator({ adapter });

        await aggregator.processEvent(event('new', 'e1', { sub_label: ['Daven', 0.87] }));
        assert.strictEqual(adapter.states['sub_labels.Daven'], true);
        assert.strictEqual(adapter.objects['sub_labels.Daven'].common.type, 'boolean');

        await aggregator.processEvent(event('end', 'e1', { sub_label: ['Daven', 0.87] }));
        assert.strictEqual(adapter.states['sub_labels.Daven'], false);
    });

    it('works without any zones configured', async () => {
        const adapter = createAdapter();
        const aggregator = new ZoneAggregator({ adapter });
        await aggregator.initZones({ cameras: { hof: {} } });

        await aggregator.processEvent(event('new', 'e1', { sub_label: 'Daven' }));
        assert.strictEqual(adapter.states['sub_labels.Daven'], true);
    });

    it('turns true when the name is recognized later in the event', async () => {
        const adapter = createAdapter();
        const aggregator = new ZoneAggregator({ adapter });

        await aggregator.processEvent(event('new', 'e1', {}));
        assert.strictEqual(adapter.states['sub_labels.Daven'], undefined);

        await aggregator.processEvent(event('update', 'e1', { sub_label: ['Daven', 0.9] }));
        assert.strictEqual(adapter.states['sub_labels.Daven'], true);
    });

    it('stays true until the last event with that name ends', async () => {
        const adapter = createAdapter();
        const aggregator = new ZoneAggregator({ adapter });

        await aggregator.processEvent(event('new', 'e1', { sub_label: 'Daven' }));
        await aggregator.processEvent(event('new', 'e2', { sub_label: 'Daven' }));
        await aggregator.processEvent(event('end', 'e1', { sub_label: 'Daven' }));
        assert.strictEqual(adapter.states['sub_labels.Daven'], true);

        await aggregator.processEvent(event('end', 'e2', { sub_label: 'Daven' }));
        assert.strictEqual(adapter.states['sub_labels.Daven'], false);
    });

    it('follows a corrected name within the same event', async () => {
        const adapter = createAdapter();
        const aggregator = new ZoneAggregator({ adapter });

        await aggregator.processEvent(event('new', 'e1', { sub_label: 'Daven' }));
        await aggregator.processEvent(event('update', 'e1', { sub_label: 'Anna' }));
        assert.strictEqual(adapter.states['sub_labels.Daven'], false);
        assert.strictEqual(adapter.states['sub_labels.Anna'], true);
    });

    it('writes a state only when its value changes', async () => {
        const adapter = createAdapter();
        const aggregator = new ZoneAggregator({ adapter });

        await aggregator.processEvent(event('new', 'e1', { sub_label: 'Daven' }));
        await aggregator.processEvent(event('update', 'e1', { sub_label: 'Daven' }));
        await aggregator.processEvent(event('update', 'e1', { sub_label: 'Daven' }));
        assert.strictEqual(adapter.writes.filter(id => id === 'sub_labels.Daven').length, 1);
    });

    it('turns dots and spaces of a name into underscores in the id and keeps the name', async () => {
        const adapter = createAdapter();
        const aggregator = new ZoneAggregator({ adapter });

        await aggregator.processEvent(event('new', 'e1', { sub_label: 'Dr. Daven Müller' }));
        assert.strictEqual(adapter.states['sub_labels.Dr__Daven_Müller'], true);
        assert.strictEqual(adapter.objects['sub_labels.Dr__Daven_Müller'].common.name, 'Dr. Daven Müller recognized');
    });

    it('resets the names left from the last run to false', async () => {
        const adapter = createAdapter(['sub_labels.Daven', 'sub_labels.Anna']);
        const aggregator = new ZoneAggregator({ adapter });

        await aggregator.resetSubLabels();
        assert.strictEqual(adapter.states['sub_labels.Daven'], false);
        assert.strictEqual(adapter.states['sub_labels.Anna'], false);

        // Known from the reset, so a new sighting must not re-create the object
        await aggregator.processEvent(event('new', 'e1', { sub_label: 'Daven' }));
        assert.strictEqual(adapter.states['sub_labels.Daven'], true);
        assert.strictEqual(adapter.objects['sub_labels.Daven'].common, undefined);
    });
});

describe('Names recognized in a zone (<zone>.sub_labels)', () => {
    it('shows the name while the person is in the zone', async () => {
        const adapter = createAdapter();
        const aggregator = new ZoneAggregator({ adapter });
        await aggregator.initZones(FRIGATE_CONFIG);
        assert.strictEqual(adapter.states['haustuer_zone.sub_labels'], '');

        await aggregator.processEvent(
            event('update', 'e1', { sub_label: ['Daven', 0.87], current_zones: ['haustuer_zone'] }),
        );
        assert.strictEqual(adapter.states['haustuer_zone.sub_labels'], 'Daven');
        assert.strictEqual(adapter.states['garten.sub_labels'], '');
    });

    it('empties when the person leaves the zone, although the event goes on', async () => {
        const adapter = createAdapter();
        const aggregator = new ZoneAggregator({ adapter });
        await aggregator.initZones(FRIGATE_CONFIG);

        await aggregator.processEvent(event('update', 'e1', { sub_label: 'Daven', current_zones: ['haustuer_zone'] }));
        await aggregator.processEvent(event('update', 'e1', { sub_label: 'Daven', current_zones: ['garten'] }));
        assert.strictEqual(adapter.states['haustuer_zone.sub_labels'], '');
        assert.strictEqual(adapter.states['garten.sub_labels'], 'Daven');
        assert.strictEqual(adapter.states['sub_labels.Daven'], true);
    });

    it('empties when the event ends', async () => {
        const adapter = createAdapter();
        const aggregator = new ZoneAggregator({ adapter });
        await aggregator.initZones(FRIGATE_CONFIG);

        await aggregator.processEvent(event('update', 'e1', { sub_label: 'Daven', current_zones: ['haustuer_zone'] }));
        await aggregator.processEvent(event('end', 'e1', { sub_label: 'Daven', current_zones: ['haustuer_zone'] }));
        assert.strictEqual(adapter.states['haustuer_zone.sub_labels'], '');
    });

    it('lists several names sorted and once each, and skips people without a name', async () => {
        const adapter = createAdapter();
        const aggregator = new ZoneAggregator({ adapter });
        await aggregator.initZones(FRIGATE_CONFIG);

        await aggregator.processEvent(event('update', 'e1', { sub_label: 'Daven', current_zones: ['haustuer_zone'] }));
        await aggregator.processEvent(event('update', 'e2', { sub_label: 'Anna', current_zones: ['haustuer_zone'] }));
        await aggregator.processEvent(event('update', 'e3', { sub_label: 'Daven', current_zones: ['haustuer_zone'] }));
        await aggregator.processEvent(event('update', 'e4', { current_zones: ['haustuer_zone'] }));
        assert.strictEqual(adapter.states['haustuer_zone.sub_labels'], 'Anna, Daven');
    });

    it('writes the zone state only when the names change', async () => {
        const adapter = createAdapter();
        const aggregator = new ZoneAggregator({ adapter });
        await aggregator.initZones(FRIGATE_CONFIG);
        adapter.writes.length = 0;

        await aggregator.processEvent(event('update', 'e1', { sub_label: 'Daven', current_zones: ['haustuer_zone'] }));
        await aggregator.processEvent(event('update', 'e1', { sub_label: 'Daven', current_zones: ['haustuer_zone'] }));
        assert.strictEqual(adapter.writes.filter(id => id === 'haustuer_zone.sub_labels').length, 1);
    });
});

describe('Face library (/api/faces)', () => {
    /**
     * @param answer what the Frigate API answers, or an Error to throw
     */
    function createContext(answer) {
        const adapter = createAdapter();
        adapter.frigateBaseUrl = 'http://frigate:5000';
        const warnings = [];
        adapter.log.warn = text => warnings.push(text);
        const requested = [];
        const requestClient = {
            get: async url => {
                requested.push(url);
                if (answer instanceof Error) {
                    throw answer;
                }
                return { data: answer };
            },
        };
        return { ctx: { adapter, requestClient }, adapter, warnings, requested };
    }

    const ENABLED = { face_recognition: { enabled: true } };

    it('returns the names of the library without the train folder', async () => {
        const { ctx, requested } = createContext({
            Daven: ['Daven-1.webp'],
            Anna: [],
            train: ['1700000000.0-abc-unknown-0.8.webp'],
        });
        assert.deepStrictEqual(await fetchFaceNames(ctx, ENABLED), ['Daven', 'Anna']);
        assert.deepStrictEqual(requested, ['http://frigate:5000/api/faces']);
    });

    it('does not ask Frigate when face recognition is not enabled', async () => {
        const { ctx, requested } = createContext({ Daven: [] });
        assert.deepStrictEqual(await fetchFaceNames(ctx, { face_recognition: { enabled: false } }), []);
        assert.deepStrictEqual(await fetchFaceNames(ctx, { cameras: {} }), []);
        assert.deepStrictEqual(requested, []);
    });

    it('returns no names and warns when the request fails', async () => {
        const { ctx, warnings } = createContext(new Error('Request failed with status code 404'));
        assert.deepStrictEqual(await fetchFaceNames(ctx, ENABLED), []);
        assert.ok(warnings.some(text => text.includes('404')));
    });

    it('returns no names for an answer that is not the expected object', async () => {
        const { ctx, warnings } = createContext(['Daven']);
        assert.deepStrictEqual(await fetchFaceNames(ctx, ENABLED), []);
        assert.strictEqual(warnings.length, 1);
    });

    it('creates the states of the library names as false', async () => {
        const adapter = createAdapter();
        const aggregator = new ZoneAggregator({ adapter });

        await aggregator.addKnownSubLabels(['Daven', 'Dr. Anna']);
        assert.strictEqual(adapter.states['sub_labels.Daven'], false);
        assert.strictEqual(adapter.states['sub_labels.Dr__Anna'], false);
        assert.strictEqual(adapter.objects['sub_labels.Dr__Anna'].common.name, 'Dr. Anna recognized');

        // Created in advance, the state still follows the events
        await aggregator.processEvent(event('new', 'e1', { sub_label: 'Daven' }));
        assert.strictEqual(adapter.states['sub_labels.Daven'], true);
    });

    it('leaves a name alone that is recognized right now', async () => {
        const adapter = createAdapter();
        const aggregator = new ZoneAggregator({ adapter });

        await aggregator.processEvent(event('new', 'e1', { sub_label: 'Daven' }));
        await aggregator.addKnownSubLabels(['Daven']);
        assert.strictEqual(adapter.states['sub_labels.Daven'], true);
    });

    it('does not create a name again that is left from the last run', async () => {
        const adapter = createAdapter(['sub_labels.Daven']);
        const aggregator = new ZoneAggregator({ adapter });
        await aggregator.resetSubLabels();
        adapter.writes.length = 0;

        await aggregator.addKnownSubLabels(['Daven']);
        assert.deepStrictEqual(adapter.writes, []);
    });
});
