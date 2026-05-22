local DataStoreHandler = {}
DataStoreHandler.__index = DataStoreHandler

local DataStoreService = game:GetService("DataStoreService")
local Players = game:GetService("Players")

local DATA_STORE_NAME = "MetropolisDataStore"
local STORE_KEY_PREFIX = "Player_"

local dataStore = DataStoreService:GetDataStore(DATA_STORE_NAME)

function DataStoreHandler.new()
    local self = setmetatable({}, DataStoreHandler)
    self.cache = {}
    return self
end

function DataStoreHandler:GetKey(player)
    return STORE_KEY_PREFIX .. player.UserId
end

function DataStoreHandler:LoadData(player)
    local key = self:GetKey(player)
    if self.cache[key] then
        return self.cache[key]
    end

    local success, data = pcall(function()
        return dataStore:GetAsync(key)
    end)

    if success and data then
        self.cache[key] = data
        return data
    else
        warn("Failed to load data for", player.Name)
        return nil
    end
end

function DataStoreHandler:SaveData(player, data)
    local key = self:GetKey(player)
    self.cache[key] = data

    local success, err = pcall(function()
        dataStore:SetAsync(key, data)
    end)

    if not success then
        warn("Failed to save data for", player.Name, err)
    end
end

function DataStoreHandler:OnPlayerAdded(player)
    local data = self:LoadData(player)
    if not data then
        data = {
            Money = 1000,
            Buildings = {},
            LevelProgress = "Level1"
        }
        self:SaveData(player, data)
    end
end

function DataStoreHandler:OnPlayerRemoving(player)
    local key = self:GetKey(player)
    if self.cache[key] then
        self:SaveData(player, self.cache[key])
    end
end

function DataStoreHandler:BindEvents()
    Players.PlayerAdded:Connect(function(player)
        self:OnPlayerAdded(player)
    end)
    
    Players.PlayerRemoving:Connect(function(player)
        self:OnPlayerRemoving(player)
    end)
end

return DataStoreHandler.new()