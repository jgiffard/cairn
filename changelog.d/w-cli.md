### Fixed

- **The CLI's staleness warning now names a command that updates the file that is running** (CAIRN-435, CAIRN-437). The agent-files job writes only `~/.local/bin/cairn` and the managed copies, so for any other file the old `launchctl kickstart` advice changed nothing; the warning now says so and names the managed copy to run or copy over it. A managed copy, or a symlink to one, still gets the per-host command, and the same release with the same CLI hash stays silent whatever the server's build commit says.
