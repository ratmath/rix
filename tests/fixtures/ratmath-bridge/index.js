// A stand-in for @ratmath/rix-bridge as `rix --ratmath=PATH` sees it: it
// exports registerRixPlugins(catalog), approves its own installers and
// returns the plugin ids to load.
import { Integer } from "@ratmath/core";

const metadata = {
    id: "outside-double",
    description: "Test host plugin supplied by an outside package.",
    kind: "host",
    mount: "outsideDouble",
    exports: ["Double"],
    groups: ["Examples"],
    permissions: [],
    defaultEnabled: false,
};

function install({ systemContext }) {
    const double = (value) => new Integer(value.value * 2n);
    systemContext.registerHostValue("outsideDouble", {
        type: "map",
        entries: new Map([["Double", double]]),
        _ext: new Map([["DOUBLE", { type: "method_builtin", name: "Double", impl: (args) => double(args[1]) }]]),
    }, { doc: metadata.description, groups: metadata.groups, pluginId: metadata.id });
}

export function registerRixPlugins(catalog) {
    catalog.addMetadata(metadata, { kind: "host" });
    catalog.registerInstaller(metadata.id, install);
    return [metadata.id];
}
