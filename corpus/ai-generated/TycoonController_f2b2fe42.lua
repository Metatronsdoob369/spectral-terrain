local TycoonController = {}
TycoonController.__index = TycoonController

-- Create a new TycoonController
function TycoonController.new(owner)
    local self = setmetatable({}, TycoonController)
    self.owner = owner
    self.activeAssets = {}
    self.cash = 0
    self:initiateGame()
    return self
end

-- Initiate game with starting setup
function TycoonController:initiateGame()
    self.cash = 1000 -- Starting cash
    self:generateInitialAssets()
end

-- Generate initial assets for the player
function TycoonController:generateInitialAssets()
    local asset1 = self:createAsset("Basic Skyscraper", 400)
    table.insert(self.activeAssets, asset1)
    local asset2 = self:createAsset("Neon Grid", 300)
    table.insert(self.activeAssets, asset2)
end

-- Function to create a new asset
function TycoonController:createAsset(assetType, cost)
    if self.cash >= cost then
        self.cash = self.cash - cost
        return {type = assetType, cost = cost, revenue = cost * 0.1} -- assuming revenue is 10% of cost
    else
        warn("Not enough cash to create asset: " .. assetType)
        return nil
    end
end

-- Collect revenue from all active assets
function TycoonController:collectRevenue()
    local totalRevenue = 0
    for _, asset in pairs(self.activeAssets) do
        totalRevenue = totalRevenue + asset.revenue
    end
    self.cash = self.cash + totalRevenue
end

-- Purchase a new asset if sufficient funds are available
function TycoonController:purchaseAsset(assetType, cost)
    local newAsset = self:createAsset(assetType, cost)
    if newAsset then
        table.insert(self.activeAssets, newAsset)
    end
end

-- Get current state of the player's Tycoon
function TycoonController:getState()
    return {
        owner = self.owner,
        cash = self.cash,
        assets = self.activeAssets
    }
end

-- Upgrade an existing asset to increase its revenue
function TycoonController:upgradeAsset(assetIndex, upgradeCost, extraRevenue)
    local asset = self.activeAssets[assetIndex]
    if asset and self.cash >= upgradeCost then
        self.cash = self.cash - upgradeCost
        asset.revenue = asset.revenue + extraRevenue
    else
        warn("Cannot upgrade asset: Not enough cash or invalid asset index")
    end
end

return TycoonController