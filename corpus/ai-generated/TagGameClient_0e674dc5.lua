local TagGameClient = {}

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local clientState = {
    isTagged = false,
    score = 0,
    player = nil,
}

local tagSignal = ReplicatedStorage:WaitForChild("TagSignal")
local tagUpdateEvent = ReplicatedStorage:WaitForChild("TagUpdateEvent")

local function onTagEvent(taggedPlayer)
    if taggedPlayer == clientState.player then
        clientState.isTagged = true
        clientState.score = clientState.score + 1
    else
        clientState.isTagged = false
    end
end

local function initialize()
    clientState.player = Players.LocalPlayer

    tagUpdateEvent.OnClientEvent:Connect(onTagEvent)

    if not RunService:IsServer() then
        Players.LocalPlayer.CharacterAdded:Connect(function()
            if clientState.isTagged then
                -- Logic to create chaos in the metropolis with involvement in the game
                -- Example: Trigger vibrancy change on player's character
            end
        end)
    end
end

function TagGameClient.start()
    initialize()
end

function TagGameClient.updateStateForChaos()
    if clientState.isTagged then
        -- Implement chaos mechanisms here (e.g., exploding obstacles)
        -- Update aspects like player visibility, tags representing the chaos status
    end
end

function TagGameClient.getScore()
    return clientState.score
end

function TagGameClient.reset()
    clientState.isTagged = false
    clientState.score = 0
end

return TagGameClient