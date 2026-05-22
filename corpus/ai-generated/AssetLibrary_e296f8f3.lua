local AssetLibrary = {}

local assets = {
    highRiseSkyscraper = {
        id = 1,
        name = "Obsidian Skyscraper",
        description = "A towering skyscraper with dark obsidian surface.",
        properties = {
            height = 750,
            material = "Obsidian",
            glow = false
        }
    },
    neonGrid = {
        id = 2,
        name = "Neon Red Street Grid",
        description = "Bright red neon grids demarcating streets.",
        properties = {
            color = "Neon Red",
            intensity = 5,
            gridSize = 10
        }
    }
}

local function addAsset(assetId, assetName, assetDescription, assetProperties)
    local newId = #assets + 1
    assets[newId] = {
        id = assetId,
        name = assetName,
        description = assetDescription,
        properties = assetProperties
    }
end

local function getAssetById(assetId)
    for _, asset in pairs(assets) do
        if asset.id == assetId then
            return asset
        end
    end
    return nil
end

local function listAssets()
    local assetList = {}
    for _, asset in pairs(assets) do
        table.insert(assetList, {
            id = asset.id,
            name = asset.name
        })
    end
    return assetList
end

local function updateAsset(assetId, newProperties)
    for _, asset in pairs(assets) do
        if asset.id == assetId then
            for prop, value in pairs(newProperties) do
                asset.properties[prop] = value
            end
            return asset
        end
    end
    return nil
end

local function removeAsset(assetId)
    for index, asset in ipairs(assets) do
        if asset.id == assetId then
            table.remove(assets, index)
            return true
        end
    end
    return false
end

AssetLibrary.addAsset = addAsset
AssetLibrary.getAssetById = getAssetById
AssetLibrary.listAssets = listAssets
AssetLibrary.updateAsset = updateAsset
AssetLibrary.removeAsset = removeAsset

return AssetLibrary