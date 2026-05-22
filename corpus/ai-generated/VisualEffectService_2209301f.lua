local VisualEffectService = {}

local replicatedStorage = game:GetService("ReplicatedStorage")
local players = game:GetService("Players")

local effectFolder = Instance.new("Folder", replicatedStorage)
effectFolder.Name = "VisualEffects"

-- Define any visual effect assets or templates
local chaosEffects = {
    "NeonRedGlow",
    "HighRiseReflection",
    "ObsidianAura",
}

-- State for tracking active effects
local activeEffects = {}

-- Initialize effect
function VisualEffectService.initEffect(effectName)
    if not table.find(chaosEffects, effectName) then
        warn("Effect not found: " .. effectName)
        return
    end

    -- If the effect already exists, we don't recreate it
    if activeEffects[effectName] then
        return activeEffects[effectName]
    end

    local newEffect = Instance.new("Folder")
    newEffect.Name = effectName
    newEffect.Parent = effectFolder

    activeEffects[effectName] = newEffect
    return newEffect
end

-- Apply an effect to a specific player
function VisualEffectService.applyEffectToPlayer(effectName, player)
    local effect = VisualEffectService.initEffect(effectName)
    if not effect then return end

    local playerGui = player:WaitForChild("PlayerGui")
    local playerEffect = effect:Clone()
    playerEffect.Parent = playerGui
end

-- Apply an effect globally
function VisualEffectService.applyGlobalEffect(effectName)
    for _, player in ipairs(players:GetPlayers()) do
        VisualEffectService.applyEffectToPlayer(effectName, player)
    end
end

-- Remove an effect from a specific player
function VisualEffectService.removeEffectFromPlayer(effectName, player)
    local playerGui = player:WaitForChild("PlayerGui")
    local playerEffect = playerGui:FindFirstChild(effectName)
    
    if playerEffect then
        playerEffect:Destroy()
    end
end

-- Remove an effect globally
function VisualEffectService.removeGlobalEffect(effectName)
    for _, player in ipairs(players:GetPlayers()) do
        VisualEffectService.removeEffectFromPlayer(effectName, player)
    end
end

-- Cleanup effects
function VisualEffectService.cleanupEffects()
    effectFolder:ClearAllChildren()
    activeEffects = {}
end

-- Setup player Added/Removing connections
players.PlayerAdded:Connect(function(player)
    -- Example: auto-apply NeonRedGlow on join
    VisualEffectService.applyEffectToPlayer("NeonRedGlow", player)
end)

players.PlayerRemoving:Connect(function(player)
    -- Cleanup player-specific effects
    for effectName, _ in pairs(activeEffects) do
        VisualEffectService.removeEffectFromPlayer(effectName, player)
    end
end)

return VisualEffectService