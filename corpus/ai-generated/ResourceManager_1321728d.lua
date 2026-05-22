local ResourceManager = {}
ResourceManager.__index = ResourceManager

function ResourceManager.new()
    local self = setmetatable({}, ResourceManager)
    self.resources = {} -- maps resource type to quantity
    self.ResourceThresholds = {
        Metal = 1000,
        Fabric = 500,
        Circuitry = 300,
        NeonEnergy = 800
    }
    return self
end

-- Adds a specified amount of a resource
function ResourceManager:AddResource(resourceType, amount)
    if not self.resources[resourceType] then
        self.resources[resourceType] = 0
    end
    self.resources[resourceType] = self.resources[resourceType] + amount
end

-- Removes a specified amount of a resource if available
function ResourceManager:RemoveResource(resourceType, amount)
    if not self.resources[resourceType] then
        return false
    end
    if self.resources[resourceType] >= amount then
        self.resources[resourceType] = self.resources[resourceType] - amount
        return true
    end
    return false
end

-- Returns the amount of a specific resource available
function ResourceManager:GetResourceAmount(resourceType)
    return self.resources[resourceType] or 0
end

-- Determines if a specific resource is below its threshold
function ResourceManager:IsResourceBelowThreshold(resourceType)
    local amount = self:GetResourceAmount(resourceType)
    return amount < (self.ResourceThresholds[resourceType] or 0)
end

-- Initializes resources with default quantities
function ResourceManager:InitializeResources()
    for resource, _ in pairs(self.ResourceThresholds) do
        self.resources[resource] = 0
    end
end

return ResourceManager