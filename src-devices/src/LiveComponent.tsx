/**
 * Live widget for ioBroker.devices.
 *
 * Points an `<img>` at the MJPEG route of the web extension. Browsers decode `multipart/x-mixed-replace`
 * natively, so no canvas and no frame handling is needed here - the picture simply moves.
 *
 * The catch: that route belongs to the *web* adapter (port 8082), while the Devices UI is usually
 * served from admin (port 8081). Only when this widget runs inside a web instance does a relative URL
 * work; everywhere else the adapter has to say where its web instance is reachable. Until that answer
 * is in, no `<img>` is rendered at all, and without an address in it the stream is not tried at all -
 * a guessed relative URL would only hit admin.
 *
 * Through the ioBroker cloud (iobroker.pro / iobroker.net) there is no stream at all: the cloud relays
 * the socket but not an endless HTTP response. There the widget fetches single pictures over the
 * socket at the configured frame rate instead, like the snapshot widget does. The same happens when
 * the adapter gives no address, or when the stream fails to load, e.g. because the browser cannot
 * reach the web instance or blocks an http stream inside an https admin.
 */
import { React, MuiMaterial, type WidgetGenericProps } from '@iobroker/dm-widgets';
import type { TypographyProps } from '@mui/material';
import type { ConfigItemPanel, ConfigItemTabs } from '@iobroker/dm-utils';

import FrigateWidgetBase, { type FrigateWidgetSettings, type FrigateWidgetState } from './FrigateWidgetBase';
import { buildWebUrl, isCloud, toDataUrl } from './frigateCommon';
import SnapshotPoller from './SnapshotPoller';

const Typography: React.ComponentType<TypographyProps> = MuiMaterial?.Typography;

export interface LiveSettings extends FrigateWidgetSettings {
    /** Base URL of the web instance, e.g. `http://192.168.1.5:8082`. Empty = same origin. */
    webUrl?: string;
    /** Frames per second requested from Frigate */
    fps?: number;
}

export interface LiveState extends FrigateWidgetState {
    /** Bumped to force the browser to re-open the stream */
    reloadCounter: number;
    /** Base URL the adapter worked out for its camera proxy, empty until the answer arrives */
    resolvedWebUrl: string;
    /** Route prefix the extension registered, empty until the answer arrives */
    resolvedRoute: string;
    /** Why no URL could be worked out; empty when there is one or the adapter said nothing */
    webReason: string;
    /** The adapter answered `frigate:getWebUrl`, or waiting for it was given up */
    webResolved: boolean;
    /** The stream failed to load, so single pictures come over the socket instead */
    streamFailed: boolean;
    /** Base64 JPEG of the newest frame, only used when the pictures come over the socket */
    frame: string;
}

/** Answer of `frigate:getWebUrl`, see `getWebUrl()` in src/main.ts */
interface WebUrlAnswer {
    url?: string;
    route?: string;
    reason?: string;
}

/** How long to wait for `frigate:getWebUrl`. An adapter too old to know the command never answers. */
const RESOLVE_TIMEOUT = 3000;

/**
 * Reason codes of `frigate:getWebUrl` mapped to what the tile shows. Anything the adapter reports
 * that is not listed here falls back to the generic hint.
 */
const REASON_TEXT: Record<string, string> = {
    disabled: 'frigate_web_disabled',
    noInstance: 'frigate_web_noInstance',
    noAddress: 'frigate_web_noAddress',
    error: 'frigate_web_error',
};

export default class LiveComponent extends FrigateWidgetBase<LiveSettings, LiveState> {
    /** Opened through the cloud: single pictures over the socket instead of the MJPEG stream */
    private readonly cloud = isCloud();

    private readonly poller: SnapshotPoller;

    /** Bumped by every `resolveWebUrl()`, so an answer or a timeout of an older run is dropped */
    private resolveGeneration = 0;

    /** Whether the poller is running, see `syncPoller()` */
    private polling = false;

    constructor(props: WidgetGenericProps<LiveSettings>) {
        super(props);
        this.state = {
            ...this.state,
            reloadCounter: 0,
            resolvedWebUrl: '',
            resolvedRoute: '',
            webReason: '',
            webResolved: false,
            streamFailed: false,
            frame: '',
        };
        this.poller = new SnapshotPoller({
            getSocket: () => this.props.stateContext.getSocket(),
            getCamera: () => this.camera,
            getParams: () => ({
                height: this.getRequestedHeight(this.state.dialogOpen),
                bbox: !!this.props.settings.bbox,
                timestamp: !!this.props.settings.timestamp,
            }),
            getInterval: () => 1000 / this.getFps(),
            onFrame: frame => this.setState({ frame, error: '' }),
            onError: error => this.setError(error),
        });
    }

    componentDidMount(): void {
        super.componentDidMount();
        if (!this.cloud) {
            void this.resolveWebUrl();
        }
        this.syncPoller();
    }

    componentDidUpdate(prevProps: WidgetGenericProps<LiveSettings>): void {
        super.componentDidUpdate(prevProps);
        if (!this.cloud) {
            // The proxy belongs to the frigate instance, so a different instance can mean a different
            // web instance and a different route
            if (prevProps.settings.instance !== this.props.settings.instance) {
                void this.resolveWebUrl();
            }
            // A typed web instance may be the one that works, so give the stream another chance. A
            // new instance or camera already restarted the camera in the base class.
            if (
                prevProps.settings.webUrl !== this.props.settings.webUrl &&
                prevProps.settings.instance === this.props.settings.instance &&
                prevProps.settings.camera === this.props.settings.camera &&
                prevProps.settings.cameraObjectId === this.props.settings.cameraObjectId &&
                this.camera
            ) {
                this.startCamera();
            }
        }
        this.syncPoller();
    }

    /**
     * Ask the adapter where its camera proxy is reachable, instead of making the user type it.
     *
     * The adapter follows its own `webInstance` setting to the web instance, that instance to its
     * host, and the host to an address in this browser's subnet - all of which it can see and the
     * widget cannot.
     */
    private async resolveWebUrl(): Promise<void> {
        const instance = this.props.settings.instance || 'frigate.0';
        const generation = ++this.resolveGeneration;
        // What an earlier instance reported does not apply to this one
        this.setState({ webResolved: false, resolvedWebUrl: '', resolvedRoute: '', webReason: '' });

        // Do not keep the tile waiting for an adapter that answers late or never: the pictures come
        // over the socket meanwhile, and a late answer with an address still switches to the stream
        const timer = setTimeout(() => {
            if (generation === this.resolveGeneration) {
                console.warn(
                    `[frigate] "frigate:getWebUrl" to ${instance}: no answer within ${RESOLVE_TIMEOUT} ms. Taking the pictures over the socket meanwhile.`,
                );
                this.setState({ webResolved: true });
            }
        }, RESOLVE_TIMEOUT);

        let answer: WebUrlAnswer | undefined;
        // Why no address came back, for the console - the tile itself just shows the pictures
        let problem = '';
        try {
            answer = await this.props.stateContext
                .getSocket()
                .sendTo(instance, 'frigate:getWebUrl', { hostname: window.location.hostname });
            if (!answer?.url && !answer?.reason) {
                problem = `answer without an address: ${JSON.stringify(answer)}`;
            }
        } catch (error) {
            problem = `request failed: ${String(error)}`;
        } finally {
            clearTimeout(timer);
        }

        if (generation !== this.resolveGeneration) {
            return;
        }
        if (problem) {
            console.warn(
                `[frigate] "frigate:getWebUrl" to ${instance}: ${problem}. Taking the pictures over the socket.`,
            );
        }

        this.setState({
            resolvedWebUrl: answer?.url || '',
            resolvedRoute: answer?.route || '',
            // Only a code the adapter really sent counts; without an address and without a code
            // the pictures come over the socket
            webReason: answer?.url ? '' : answer?.reason || '',
            webResolved: true,
            // Whatever went wrong with the URL known before does not apply to this one
            error: '',
        });
    }

    /**
     * Single pictures over the socket: always behind the cloud; elsewhere once the stream failed to
     * load, or when the adapter gave neither an address nor a reason. Guessing a relative URL is no
     * option then - in admin it only produces a 404.
     */
    private useSocket(): boolean {
        return (
            this.cloud ||
            this.state.streamFailed ||
            (this.state.webResolved && !this.state.webReason && this.getStreamBase() === null)
        );
    }

    /** Keep the poller running exactly as long as the pictures come over the socket */
    private syncPoller(): void {
        const wanted = !!this.camera && this.useSocket();
        if (wanted !== this.polling) {
            this.polling = wanted;
            if (wanted) {
                this.poller.start();
            } else {
                this.poller.stop();
            }
        }
    }

    /**
     * The stream did not load, most likely because the browser cannot reach the web instance or
     * blocks an http stream inside an https page. The socket still works, so take the pictures from
     * there instead of leaving the tile with an error.
     *
     * @param url the stream URL that failed
     */
    private onStreamError(url: string): void {
        if (this.state.streamFailed) {
            return;
        }
        console.warn(`[frigate] Cannot load the stream from ${url}. Taking the pictures over the socket.`);
        this.setState({ streamFailed: true, error: '' });
    }

    /**
     * Base the stream URL is built on: a URL, '' for the page's own origin, or `null` while nobody has
     * said where the stream is.
     *
     * A value typed into the settings wins, because only the user knows about an external domain or
     * a reverse proxy. Where the computed URL is the page's own origin the relative form is used
     * instead: it survives such a proxy and cannot trip the mixed-content rules of an https page.
     */
    private getStreamBase(): string | null {
        const base = this.props.settings.webUrl || this.state.resolvedWebUrl;
        if (!base) {
            return null;
        }
        if (typeof window !== 'undefined' && base.replace(/\/+$/, '') === window.location.origin) {
            return '';
        }
        return base;
    }

    /** Frame rate within the bounds of the settings dialog */
    private getFps(): number {
        return Math.min(30, Math.max(1, parseInt(this.props.settings.fps as unknown as string, 10) || 5));
    }

    static override getConfigSchema(): { name: string; schema: ConfigItemPanel | ConfigItemTabs } {
        return FrigateWidgetBase.buildConfigSchema('frigate_LiveCamera', {
            _webHint: {
                type: 'staticText',
                text: 'frigate_live_needs_web',
                sm: 12,
            },
            _fallbackHint: {
                type: 'staticText',
                text: 'frigate_live_fallback',
                sm: 12,
            },
            webUrl: {
                type: 'text',
                label: 'frigate_webUrl',
                help: 'frigate_webUrl_help',
                sm: 12,
            },
            fps: {
                type: 'number',
                label: 'frigate_fps',
                help: 'frigate_fps_help',
                default: 5,
                min: 1,
                max: 30,
                sm: 12,
                md: 6,
            },
        });
    }

    /**
     * Only resets what belongs to the last try. The poller follows `useSocket()` in `syncPoller()`,
     * and the stream needs no starting or stopping: the browser opens it when the `<img>` is mounted
     * and closes it when React removes the element again.
     */
    protected startCamera(): void {
        // A new camera or new settings deserve another try with the stream, even after it failed
        this.setState({ streamFailed: false, frame: '', error: '', reloadCounter: this.state.reloadCounter + 1 });
    }

    protected stopCamera(): void {
        this.poller.stop();
        this.polling = false;
    }

    /** The dialog asks for a bigger picture, so fetch it now instead of after the running interval */
    protected override onDialogToggled(): void {
        this.poller.reschedule();
    }

    protected renderImage(full?: boolean): React.JSX.Element | null {
        if (!this.camera) {
            return null;
        }

        if (this.useSocket()) {
            if (!this.state.frame) {
                return null;
            }
            return (
                <img
                    src={toDataUrl(this.state.frame)}
                    alt={this.camera.name}
                    style={FrigateWidgetBase.styleFor(full)}
                />
            );
        }

        // Nobody has said yet where the stream is: the adapter has not answered, or it named a reason
        // that renderPicture() shows instead. A relative URL would go to whatever serves this page -
        // admin in most installations, which knows nothing about the stream.
        const base = this.getStreamBase();
        if (base === null) {
            return null;
        }

        const url = buildWebUrl(base, this.state.resolvedRoute, this.camera, 'stream.mjpeg', {
            fps: this.getFps(),
            height: this.getRequestedHeight(full),
            ...this.getDrawParams(),
        });

        return (
            <img
                // The counter is part of the key, so a re-mount really re-opens the stream
                key={`${url}#${this.state.reloadCounter}`}
                src={url}
                alt={this.camera.name}
                style={FrigateWidgetBase.styleFor(full)}
                onError={() => this.onStreamError(url)}
            />
        );
    }

    /**
     * Show why the camera proxy cannot be reached, but only when neither the settings nor the adapter
     * produced a base URL. Behind the cloud and after a fallback the web instance plays no part, so no
     * such hint applies - the errors of the socket are the useful ones there.
     */
    protected override renderPicture(full?: boolean): React.JSX.Element {
        // The adapter named a cause, so say it straight away instead of letting the browser run into
        // a 404 first
        if (!this.useSocket() && this.camera && this.getStreamBase() === null && this.state.webReason) {
            return (
                <Typography
                    variant="caption"
                    sx={{ color: 'text.secondary', p: 1, overflow: 'hidden' }}
                >
                    {FrigateWidgetBase.t(REASON_TEXT[this.state.webReason] || 'frigate_stream_needs_web')}
                </Typography>
            );
        }

        return super.renderPicture(full);
    }
}
