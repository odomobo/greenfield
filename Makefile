.PHONY: all scene-protocol session viewer gatekeeper clean

all: session viewer gatekeeper

# --- packages (TS) ---

scene-protocol:
	cd packages/scene-protocol && npx tsc

session: scene-protocol
	cd packages/session && rm -rf dist types && npm run build:native && npx tsc && node dist/build-dconf.js && node dist/build-audio.js

viewer: scene-protocol
	cd packages/viewer && npm run build:wasm && npx tsc --noEmit && npx vite build

# --- packages (Rust) ---

gatekeeper:
	cargo build --release --locked --manifest-path packages/gatekeeper/Cargo.toml

# --- housekeeping ---

clean:
	rm -rf packages/scene-protocol/dist packages/scene-protocol/types
	rm -rf packages/session/build packages/session/dist packages/session/types
	rm -rf packages/viewer/dist
	cd packages/gatekeeper && cargo clean
