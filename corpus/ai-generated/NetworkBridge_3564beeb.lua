local NetworkBridge = {}

local eventListeners = {}
local eventQueue = {}
local isServer = game:GetService("RunService"):IsServer()

function NetworkBridge:Init()
    if isServer then
        self.remoteEvent = Instance.new("RemoteEvent")
        self.remoteEvent.Name = "GameNetworkEvent"
        self.remoteEvent.Parent = game:GetService("ReplicatedStorage")
    else
        self.remoteEvent = game:GetService("ReplicatedStorage"):WaitForChild("GameNetworkEvent")
    end

    self.remoteEvent.OnServerEvent:Connect(function(...)
        self:HandleIncomingEvent(nil, ...)
    end)

    self.remoteEvent.OnClientEvent:Connect(function(...)
        self:HandleIncomingEvent(...)
    end)
end

function NetworkBridge:HandleIncomingEvent(player, eventName, ...)
    local listeners = eventListeners[eventName]
    if listeners then
        for _, listener in ipairs(listeners) do
            listener(player, ...)
        end
    else
        table.insert(eventQueue, { player = player, eventName = eventName, args = { ... } })
    end
end

function NetworkBridge:RegisterEvent(eventName, callback)
    if not eventListeners[eventName] then
        eventListeners[eventName] = {}
    end
    table.insert(eventListeners[eventName], callback)

    for i = #eventQueue, 1, -1 do
        if eventQueue[i].eventName == eventName then
            callback(eventQueue[i].player, unpack(eventQueue[i].args))
            table.remove(eventQueue, i)
        end
    end
end

function NetworkBridge:FireClient(player, eventName, ...)
    if isServer then
        self.remoteEvent:FireClient(player, eventName, ...)
    end
end

function NetworkBridge:FireAllClients(eventName, ...)
    if isServer then
        self.remoteEvent:FireAllClients(eventName, ...)
    end
end

function NetworkBridge:FireServer(eventName, ...)
    if not isServer then
        self.remoteEvent:FireServer(eventName, ...)
    end
end

NetworkBridge:Init()

return NetworkBridge