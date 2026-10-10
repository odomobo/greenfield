.PHONY: all check lint test scene-protocol session-contracts frames congestion video-codec session viewer gatekeeper clean

all: session viewer gatekeeper

# --- packages (TS) ---

scene-protocol:
	cd packages/scene-protocol && npx tsc

# Packages are built in dependency order: tsc -b builds a package's project references first, and the Makefile
# targets say the same, so a package is built after the packages it imports.
session-contracts: scene-protocol
	cd packages/session-contracts && npm run build

# The frame library (native, linked statically into session's wlr-core addon and the video codec's addon) and its test
# addon.
frames: session-contracts
	cd packages/frames && npm run build

# The BBR-style congestion estimator.
congestion: session-contracts
	cd packages/congestion && npm run build

# The video codec: the GStreamer encoder (its own native addon, reading frames), the encoder pool, encoder detection.
video-codec: session-contracts frames
	cd packages/video-codec && npm run build

session: session-contracts frames congestion video-codec
	cd packages/session && rm -rf dist types && npm run build:native && npx tsc -b && node dist/build-dconf.js && node dist/build-audio.js

viewer: scene-protocol
	cd packages/viewer && npm run build:wasm && npx tsc --noEmit && npx vite build

# --- the test gate ---

# Builds everything, lints and runs every package's unit tests. Fails if any part fails. (The end-to-end suite,
# scripts/test-gateway.sh, is run separately.)
check: all lint test

lint:
	cd packages/session-contracts && npm run lint
	cd packages/frames && npm run lint
	cd packages/congestion && npm run lint
	cd packages/video-codec && npm run lint
	cd packages/session && npm run lint

test:
	cd packages/session-contracts && npm test
	cd packages/frames && npm test
	cd packages/congestion && npm test
	cd packages/video-codec && npm test
	cd packages/session && npm test
	cd packages/viewer && npm test

# --- packages (Rust) ---

gatekeeper:
	cargo build --release --locked --manifest-path packages/gatekeeper/Cargo.toml

# --- housekeeping ---

clean:
	rm -rf packages/scene-protocol/dist packages/scene-protocol/types
	rm -rf packages/session-contracts/dist packages/session-contracts/types
	rm -rf packages/congestion/dist packages/congestion/types
	rm -rf packages/frames/build packages/frames/dist packages/frames/types
	rm -rf packages/video-codec/build packages/video-codec/dist packages/video-codec/types
	rm -rf packages/session/build packages/session/dist packages/session/types
	rm -rf packages/viewer/dist
	# tsc -b's incremental state: left behind, it would take the removed output for up to date
	rm -f packages/*/tsconfig.tsbuildinfo
	cd packages/gatekeeper && cargo clean
