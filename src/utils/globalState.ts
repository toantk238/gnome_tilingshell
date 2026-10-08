import { registerGObjectClass } from '../utils/gjs';
import Layout from '../components/layout/Layout';
import Settings from '../settings/settings';
import SignalHandling from './signalHandling';
import { GObject, Meta, Gio } from '../gi/ext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { logger } from './logger';
import { getWindows } from './ui';
import ExtendedWindow from '../components/tilingsystem/extendedWindow';

const debug = logger('GlobalState');

export default class GlobalState extends GObject.Object {
    static { registerGObjectClass(this, {
        GTypeName: 'GlobalState',
        Signals: {
            'layouts-changed': {
                param_types: [],
            },
        },
        Properties: {
            tilePreviewAnimationTime: GObject.ParamSpec.uint(
                'tilePreviewAnimationTime',
                'tilePreviewAnimationTime',
                'Animation time of tile previews in milliseconds',
                GObject.ParamFlags.READWRITE,
                0,
                2000,
                100,
            ),
        },
    })};

    public static SIGNAL_LAYOUTS_CHANGED = 'layouts-changed';

    private static _instance: GlobalState | null;

    private _signals: SignalHandling;
    private _layouts: Layout[];
    private _tilePreviewAnimationTime: number;
    // if workspaces are reordered, we use this map to know which layouts where selected
    // to each workspace and we save the new ordering in the settings
    private _selected_layouts: Map<Meta.Workspace, string[]>; // used to handle reordering of workspaces
    // the monitor setup the selected layouts were last validated for. Used to
    // restore the layouts of a monitor setup when it comes back (e.g. after a
    // remote desktop session added/removed a virtual monitor)
    private _monitorSetup: string | undefined;

    static get(): GlobalState {
        if (!this._instance) this._instance = new GlobalState();

        return this._instance;
    }

    static destroy() {
        if (this._instance) {
            this._instance._signals.disconnect();
            this._instance._layouts = [];
            this._instance = null;
        }
    }

    constructor() {
        super();

        this._signals = new SignalHandling();
        this._layouts = Settings.get_layouts_json();
        this._tilePreviewAnimationTime = 100;
        this._selected_layouts = new Map();
        this._monitorSetup = undefined;
        this.validate_selected_layouts();

        Settings.bind(
            Settings.KEY_TILE_PREVIEW_ANIMATION_TIME,
            this,
            'tilePreviewAnimationTime',
            Gio.SettingsBindFlags.GET,
        );
        this._signals.connect(
            Settings,
            Settings.KEY_SETTING_LAYOUTS_JSON,
            () => {
                this._layouts = Settings.get_layouts_json();
                this.emit(GlobalState.SIGNAL_LAYOUTS_CHANGED);
            },
        );

        this._signals.connect(
            Settings,
            Settings.KEY_SETTING_SELECTED_LAYOUTS,
            () => {
                const selected_layouts = Settings.get_selected_layouts();
                if (selected_layouts.length === 0) {
                    this.validate_selected_layouts();
                    return;
                }

                const defaultLayout: Layout = this._layouts[0];
                const n_monitors = Main.layoutManager.monitors.length;
                const n_workspaces = global.workspaceManager.get_n_workspaces();
                for (let i = 0; i < n_workspaces; i++) {
                    const ws =
                        global.workspaceManager.get_workspace_by_index(i);
                    if (!ws) continue;

                    const monitors_layouts =
                        i < selected_layouts.length
                            ? selected_layouts[i]
                            : [defaultLayout.id];
                    while (monitors_layouts.length < n_monitors)
                        monitors_layouts.push(defaultLayout.id);
                    while (monitors_layouts.length > n_monitors)
                        monitors_layouts.pop();

                    this._selected_layouts.set(ws, monitors_layouts);
                }

                this._rememberSelectedLayoutsOfMonitorSetup();
            },
        );

        // the monitors may change without changing their number (e.g. a
        // physical monitor replaced by a virtual one), so check the setup here
        this._signals.connect(Main.layoutManager, 'monitors-changed', () => {
            if (this._monitorSetup !== this._computeMonitorSetup())
                this.validate_selected_layouts();
        });

        this._signals.connect(
            global.workspaceManager,
            'workspace-added',
            (_, index: number) => {
                const n_workspaces = global.workspaceManager.get_n_workspaces();
                const newWs =
                    global.workspaceManager.get_workspace_by_index(index);
                if (!newWs) return;

                debug(`added workspace ${index}`);

                const secondLastWs =
                    global.workspaceManager.get_workspace_by_index(
                        n_workspaces - 2,
                    );

                // the new workspace must start with the same layout of the last workspace
                // use the layout at index 0 if for some reason we cannot find the layout
                // of the last workspace
                const secondLastWsLayoutsId = secondLastWs
                    ? (this._selected_layouts.get(secondLastWs) ?? [])
                    : [];
                if (secondLastWsLayoutsId.length === 0) {
                    secondLastWsLayoutsId.push(
                        ...Main.layoutManager.monitors.map(
                            () => this._layouts[0].id,
                        ),
                    );
                }

                this._selected_layouts.set(
                    newWs,
                    secondLastWsLayoutsId, // Main.layoutManager.monitors.map(() => layout.id),
                );

                const to_be_saved: string[][] = [];
                for (let i = 0; i < n_workspaces; i++) {
                    const ws =
                        global.workspaceManager.get_workspace_by_index(i);
                    if (!ws) continue;
                    const monitors_layouts = this._selected_layouts.get(ws);
                    if (!monitors_layouts) continue;
                    to_be_saved.push(monitors_layouts);
                }

                Settings.save_selected_layouts(to_be_saved);
            },
        );

        this._signals.connect(
            global.workspaceManager,
            'workspace-removed',
            () => {
                const newMap: Map<Meta.Workspace, string[]> = new Map();
                const n_workspaces = global.workspaceManager.get_n_workspaces();
                const to_be_saved: string[][] = [];
                for (let i = 0; i < n_workspaces; i++) {
                    const ws =
                        global.workspaceManager.get_workspace_by_index(i);
                    if (!ws) continue;
                    const monitors_layouts = this._selected_layouts.get(ws);
                    if (!monitors_layouts) continue;

                    this._selected_layouts.delete(ws);
                    newMap.set(ws, monitors_layouts);
                    to_be_saved.push(monitors_layouts);
                }
                Settings.save_selected_layouts(to_be_saved);

                this._selected_layouts.clear();
                this._selected_layouts = newMap;
                debug('deleted workspace');
            },
        );

        this._signals.connect(
            global.workspaceManager,
            'workspaces-reordered',
            () => {
                this._save_selected_layouts();
                debug('reordered workspaces');
            },
        );
    }

    public validate_selected_layouts() {
        const n_monitors = Main.layoutManager.monitors.length;
        const current_selected_layouts = Settings.get_selected_layouts();
        let old_selected_layouts = current_selected_layouts;

        // if the monitor setup changed, or the selected layouts were saved for
        // a different number of monitors, restore what was selected the last
        // time this monitor setup was used
        const monitorSetup = this._computeMonitorSetup();
        const setupChanged =
            this._monitorSetup !== undefined &&
            this._monitorSetup !== monitorSetup;
        const sizeMismatch = current_selected_layouts.some(
            (monitors_layouts) => monitors_layouts.length !== n_monitors,
        );
        const remembered =
            Settings.get_selected_layouts_per_monitor_setup()[monitorSetup];
        if (Array.isArray(remembered) && (setupChanged || sizeMismatch)) {
            debug(`restoring selected layouts of monitor setup ${monitorSetup}`);
            old_selected_layouts = remembered.map((monitors_layouts, i) =>
                Array.isArray(monitors_layouts)
                    ? [...monitors_layouts]
                    : (current_selected_layouts[i] ?? []),
            );
        }
        this._monitorSetup = monitorSetup;

        for (let i = 0; i < global.workspaceManager.get_n_workspaces(); i++) {
            const ws = global.workspaceManager.get_workspace_by_index(i);
            if (!ws) continue;

            const monitors_layouts =
                old_selected_layouts[i] ?? current_selected_layouts[i] ?? [];
            while (monitors_layouts.length < n_monitors)
                monitors_layouts.push(this._layouts[0].id);
            while (monitors_layouts.length > n_monitors) monitors_layouts.pop();

            monitors_layouts.forEach((_, ind) => {
                if (
                    this._layouts.findIndex(
                        (lay) => lay.id === monitors_layouts[ind],
                    ) === -1
                )
                    monitors_layouts[ind] = monitors_layouts[0];
            });

            this._selected_layouts.set(ws, monitors_layouts);
        }

        this._save_selected_layouts();
        this._rememberSelectedLayoutsOfMonitorSetup();
    }

    private _save_selected_layouts() {
        const to_be_saved: string[][] = [];
        const n_workspaces = global.workspaceManager.get_n_workspaces();
        for (let i = 0; i < n_workspaces; i++) {
            const ws = global.workspaceManager.get_workspace_by_index(i);
            if (!ws) continue;
            const monitors_layouts = this._selected_layouts.get(ws);
            if (!monitors_layouts) continue;
            to_be_saved.push(monitors_layouts);
        }

        Settings.save_selected_layouts(to_be_saved);
    }

    // identifies the current monitor setup, by connector names (e.g. "DP-1|HDMI-2")
    // in monitor index order, falling back to the monitors geometry
    private _computeMonitorSetup(): string {
        try {
            const logicalMonitors = global.backend
                .get_monitor_manager()
                .get_logical_monitors?.();
            if (logicalMonitors && logicalMonitors.length > 0) {
                return [...logicalMonitors]
                    .sort((a, b) => a.get_number() - b.get_number())
                    .map((logicalMonitor) =>
                        logicalMonitor
                            .get_monitors()
                            .map((monitor) => monitor.get_connector())
                            .join('+'),
                    )
                    .join('|');
            }
        } catch (e) {
            debug('cannot read the monitor connectors', e);
        }

        return Main.layoutManager.monitors
            .map((m) => `${m.x},${m.y},${m.width}x${m.height}`)
            .join('|');
    }

    private _rememberSelectedLayoutsOfMonitorSetup() {
        // the selected layouts belong to the monitor setup they were validated for
        const monitorSetup = this._computeMonitorSetup();
        if (this._monitorSetup !== monitorSetup) return;

        const selected = Settings.get_selected_layouts();
        const n_monitors = Main.layoutManager.monitors.length;
        if (
            selected.length === 0 ||
            selected.some((monitors_layouts) => monitors_layouts.length !== n_monitors)
        )
            return;

        const perSetup = Settings.get_selected_layouts_per_monitor_setup();
        if (JSON.stringify(perSetup[monitorSetup]) === JSON.stringify(selected))
            return;

        perSetup[monitorSetup] = selected;
        Settings.save_selected_layouts_per_monitor_setup(perSetup);
    }

    get layouts(): Layout[] {
        return this._layouts;
    }

    public addLayout(newLay: Layout) {
        this._layouts.push(newLay);
        // easy way to trigger save and signal emission
        this.layouts = this._layouts;
    }

    public deleteLayout(layoutToDelete: Layout) {
        const layFoundIndex = this._layouts.findIndex(
            (lay) => lay.id === layoutToDelete.id,
        );
        if (layFoundIndex === -1) return;

        this._layouts.splice(layFoundIndex, 1);

        // easy way to trigger a save and emit layouts-changed signal
        this.layouts = this._layouts;

        this._selected_layouts.forEach((monitors_selected) => {
            if (
                layoutToDelete.id ===
                monitors_selected[Main.layoutManager.primaryIndex]
            ) {
                monitors_selected[Main.layoutManager.primaryIndex] =
                    this._layouts[0].id;
                this._save_selected_layouts();
            }
        });
    }

    public editLayout(newLay: Layout) {
        const layFoundIndex = this._layouts.findIndex(
            (lay) => lay.id === newLay.id,
        );
        if (layFoundIndex === -1) return;

        this._layouts[layFoundIndex] = newLay;
        // easy way to trigger save and signal emission
        this.layouts = this._layouts;
    }

    public swapLayouts(first: number, second: number) {
        const tmp = this._layouts[first];
        this._layouts[first] = this._layouts[second];
        this._layouts[second] = tmp;
        // easy way to trigger save and signal emission
        this.layouts = this._layouts;
    }

    set layouts(layouts: Layout[]) {
        this._layouts = layouts;
        Settings.save_layouts_json(layouts);
        this.emit(GlobalState.SIGNAL_LAYOUTS_CHANGED);
    }

    public getSelectedLayoutOfMonitor(
        monitorIndex: number,
        workspaceIndex: number,
    ): Layout {
        const selectedLayouts = Settings.get_selected_layouts();
        if (workspaceIndex < 0 || workspaceIndex >= selectedLayouts.length)
            workspaceIndex = 0;

        const monitors_selected =
            workspaceIndex < selectedLayouts.length
                ? selectedLayouts[workspaceIndex]
                : GlobalState.get().layouts[0].id;
        if (monitorIndex < 0 || monitorIndex >= monitors_selected.length)
            monitorIndex = 0;

        return (
            this._layouts.find(
                (lay) => lay.id === monitors_selected[monitorIndex],
            ) || this._layouts[0]
        );
    }

    public get tilePreviewAnimationTime(): number {
        return this._tilePreviewAnimationTime;
    }

    public set tilePreviewAnimationTime(value: number) {
        this._tilePreviewAnimationTime = value;
    }

    public setSelectedLayoutOfMonitor(
        layoutToSelectId: string,
        monitorIndex: number,
    ) {
        // get the currently selected layouts
        const selected = Settings.get_selected_layouts();
        // select the layout for the given monitor
        selected[global.workspaceManager.get_active_workspace_index()][
            monitorIndex
        ] = layoutToSelectId;

        // if there are 2 or more workspaces, if the last workspace is empty
        // it must follow the layout of the second-last workspace
        // if we changed the second-last workspace we take care of changing
        // the last workspace as well, if there aren't tiled windows (is empty)
        const n_workspaces = global.workspaceManager.get_n_workspaces();
        if (
            global.workspaceManager.get_active_workspace_index() ===
            n_workspaces - 2
        ) {
            const lastWs = global.workspaceManager.get_workspace_by_index(
                n_workspaces - 1,
            );
            if (!lastWs) return;

            // check if there are tiled windows on that monitor and in the last workspace
            const tiledWindows = getWindows(lastWs).find(
                (win) =>
                    (win as ExtendedWindow).assignedTile &&
                    win.get_monitor() === monitorIndex,
            );
            if (!tiledWindows) {
                // the last workspace, on that monitor, is empty
                // select the same layout for last workspace as well
                selected[lastWs.index()][monitorIndex] = layoutToSelectId;
            }
        }

        Settings.save_selected_layouts(selected);
    }
}
