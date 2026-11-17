-- This script is bundled with the bridge. All input is data on a private socket.
io.stdout:setvbuf("no")
print("VAULTDRIVE-READY")

local count = assert(tonumber(io.stdin:read("*l")))
local selected = assert(tonumber(io.stdin:read("*l")))
assert(count >= 1 and count <= 10000 and selected >= 1 and selected <= count)

local items = {}
for index = 1, count do
  local url = assert(io.stdin:read("*l"))
  local name = assert(io.stdin:read("*l"))
  items[index] = { path = url, name = name, options = { "meta-title=" .. name } }
end

assert(vlc.playlist.enqueue(items) == count)
local playlist = vlc.playlist.get("playlist")
assert(playlist.children and #playlist.children == count)
vlc.playlist.gotoitem(playlist.children[selected].id)
print("VAULTDRIVE-PLAYING")
