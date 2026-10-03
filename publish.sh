#!/usr/bin/env sh

printf "\n!!! Make sure you are logged in by running 'yarn npm login' first !!!\n\n"

export TOKEN="$(cat token)"
yarn workspaces foreach -vA --exclude root-workspace* --exclude @gfld/example* --exclude @gfld/gateway --exclude @gfld/viewer npm publish --tolerate-republish