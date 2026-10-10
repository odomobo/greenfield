.PHONY: all check lint test scene-protocol session-contracts patch-codec frames congestion scheduler session viewer gatekeeper clean

all: session viewer gatekeeper

# --- packages (TS) ---

scene-protocol:
	cd packages/scene-protocol && npx tsc

# Packages are built in dependency order: tsc -b builds a package's project references first, and the Makefile
# targets say the same, so a package is built after the packages it imports.
session-contracts: scene-protocol
	cd packages/session-contracts && npm run build

# The patch codec: PNG, and QOI / LZ4 / JPEG in a native addon, with the worker pools.
patch-codec: session-contracts
	cd packages/patch-codec && npm run build

# The frame library (native, linked statically into session's wlr-core addon) and its test addon.
frames: session-contracts
	cd packages/frames && npm run build

# The BBR-style congestion estimator.
congestion: session-contracts
	cd packages/congestion && npm run build

# Which surface gets the next free patch encoder, and frame pacing.
scheduler: session-contracts
	cd packages/scheduler && npm run build

session: session-contracts frames congestion scheduler patch-codec
	cd packages/session && rm -rf dist types && npm run build:native && npx tsc -b && node dist/build-dconf.js && node dist/build-audio.js

viewer: scene-protocol patch-codec
	cd packages/viewer && npm run build:wasm && npx tsc --noEmit && npx vite build

# --- the test gate ---

# Builds everything, lints and runs every package's unit tests. Fails if any part fails. (The end-to-end suite,
# scripts/test-gateway.sh, is run separately.)
check: all lint test

lint:
	cd packages/session-contracts && npm run lint
	cd packages/frames && npm run lint
	cd packages/congestion && npm run lint
	cd packages/scheduler && npm run lint
	cd packages/patch-codec && npm run lint
	cd packages/session && npm run lint

test:
	cd packages/session-contracts && npm test
	cd packages/frames && npm test
	cd packages/congestion && npm test
	cd packages/scheduler && npm test
	cd packages/patch-codec && npm test
	cd packages/session && npm test
	cd packages/viewer && npm test

# --- packages (Rust) ---

gatekeeper:
	cargo build --release --locked --manifest-path packages/gatekeeper/Cargo.toml

# --- housekeeping ---

clean:
	rm -rf packages/scene-protocol/dist packages/scene-protocol/types
	rm -rf packages/session-contracts/dist packages/session-contracts/types packages/session-contracts/tsconfig.tsbuildinfo
	rm -rf packages/congestion/dist packages/congestion/types packages/congestion/tsconfig.tsbuildinfo
	rm -rf packages/scheduler/dist packages/scheduler/types packages/scheduler/tsconfig.tsbuildinfo
	rm -rf packages/frames/build packages/frames/dist packages/frames/types packages/frames/tsconfig.tsbuildinfo
	rm -rf packages/patch-codec/build packages/patch-codec/dist packages/patch-codec/types packages/patch-codec/tsconfig.tsbuildinfo
	rm -rf packages/session/build packages/session/dist packages/session/types
	rm -rf packages/viewer/dist
	cd packages/gatekeeper && cargo clean
