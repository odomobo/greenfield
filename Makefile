.PHONY: all scene-protocol session viewer gatekeeper clean

all: session viewer gatekeeper

# --- libs ---

scene-protocol:
	cd libs/scene-protocol && yarn run tsc

# --- packages (TS + C) ---

session: scene-protocol
	cd packages/session && yarn run rimraf dist types && yarn build:native && yarn build:typescript && node dist/build-dconf.js && node dist/build-audio.js

viewer: scene-protocol
	cd packages/viewer && yarn build:wasm && yarn tsc --noEmit && yarn vite build

# --- packages (Rust) ---

gatekeeper:
	cargo build --release --locked --manifest-path packages/gatekeeper/Cargo.toml

# --- housekeeping ---

clean:
	rm -rf libs/scene-protocol/dist libs/scene-protocol/types
	rm -rf packages/session/build packages/session/dist packages/session/types
	rm -rf packages/viewer/dist
	cd packages/gatekeeper && cargo clean
