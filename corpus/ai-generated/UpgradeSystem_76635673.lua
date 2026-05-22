local UpgradeSystem = {}
UpgradeSystem.__index = UpgradeSystem

local Players = game:GetService("Players")
local DataStoreService = game:GetService("DataStoreService")
local UpgradesStore = DataStoreService:GetDataStore("PlayerUpgrades") 

-- Configuration Table for Upgrades
UpgradeSystem.config = {
    highRiseConstructionSpeed = {cost = 1000, level = 1, maxLevel = 10, effectRate = 0.1},
    neonStreetGridEfficiency = {cost = 2000, level = 1, maxLevel = 10, effectRate = 0.15}
}

UpgradeSystem.playerData = {}

local function updateUpgradeCost(upgrade)
    return upgrade.cost * 2 ^ (upgrade.level - 1)
end

local function savePlayerData(player)
    if UpgradeSystem.playerData[player.UserId] then
        local success, errorMessage = pcall(function()
            UpgradesStore:SetAsync(tostring(player.UserId), UpgradeSystem.playerData[player.UserId])
        end)
        if not success then
            warn("Failed to save data for player " .. player.Name .. ": " .. errorMessage)
        end
    end
end

function UpgradeSystem:LoadPlayerData(player)
    local success, data = pcall(function()
        return UpgradesStore:GetAsync(tostring(player.UserId))
    end)
    
    if success then
        UpgradeSystem.playerData[player.UserId] = data or {highRiseConstructionSpeed = 1, neonStreetGridEfficiency = 1}
    else
        warn("Failed to load data for player " .. player.Name)
    end
end

function UpgradeSystem:UpgradeFeature(player, feature)
    local playerId = player.UserId
    local playerUpgrades = UpgradeSystem.playerData[playerId] or {}

    local upgrade = UpgradeSystem.config[feature]
    if playerUpgrades[feature] >= upgrade.maxLevel then
        return false, "Max level reached"
    end

    local upgradeCost = updateUpgradeCost(upgrade)

    if player:CanAfford(upgradeCost) then
        player:SpendCurrency(upgradeCost)
        playerUpgrades[feature] = playerUpgrades.get(feature, 0) + 1
        UpgradeSystem.playerData[playerId] = playerUpgrades
        savePlayerData(player)
        return true, "Upgrade successful"
    else
        return false, "Insufficient funds"
    end
end

function UpgradeSystem:GetUpgradeLevel(player, feature)
    local playerData = UpgradeSystem.playerData[player.UserId]
    return playerData and playerData[feature] or 1
end

Players.PlayerAdded:Connect(function(player)
    UpgradeSystem:LoadPlayerData(player)
end)

Players.PlayerRemoving:Connect(function(player)
    savePlayerData(player)
    UpgradeSystem.playerData[player.UserId] = nil
end)

return UpgradeSystem