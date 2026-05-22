local AssetLibrary = {}
AssetLibrary.__index = AssetLibrary

local RunService = game:GetService("RunService")
local ServerScriptService = game:GetService("ServerScriptService")
local assetsFolder = ServerScriptService:FindFirstChild("AssetsLibrary") or Instance.new("Folder")

assetsFolder.Name = "AssetsLibrary"
assetsFolder.Parent = ServerScriptService

local loadedAssets = {}

function AssetLibrary.new()
    if RunService:IsClient() then
        error("AssetLibrary can only be used on the server")
    end
    local self = setmetatable({}, AssetLibrary)
    return self
end

function AssetLibrary:LoadAsset(assetName)
    if not loadedAssets[assetName] then
        local asset = assetsFolder:FindFirstChild(assetName)
        if asset then
            loadedAssets[assetName] = asset:Clone()
        else
            warn("Asset not found: ", assetName)
            return nil
        end
    end
    return loadedAssets[assetName]
end

function AssetLibrary:GenerateAsset(assetName, prompt)
    if self:LoadAsset(assetName) then
        return error("Asset already loaded")
    end

    local newAsset = Instance.new("Model")
    newAsset.Name = assetName

    if prompt == "cathedral Gothic Cyber-Cathedral architecture mission. Build EVERYTHING at 0,0,0. Obsidian arches, N..." then
        -- Create architecture based on the prompt
        local basePart = Instance.new("Part")
        basePart.Size = Vector3.new(100, 1, 100)
        basePart.Position = Vector3.new(0, 0, 0)
        basePart.Anchored = true
        basePart.BrickColor = BrickColor.new("Obsidian")
        basePart.Parent = newAsset
        
        -- Add Cyber-Cathedral details
        local arch = Instance.new("Part")
        arch.Size = Vector3.new(10, 40, 3)
        arch.Position = Vector3.new(0, 20, 10)
        arch.Anchored = true
        arch.BrickColor = BrickColor.new("Obsidian")
        arch.Parent = newAsset
    else
        warn("Unsupported prompt for asset generation")
        return nil
    end

    newAsset.Parent = assetsFolder
    loadedAssets[assetName] = newAsset

    return newAsset
end

function AssetLibrary:GetLoadedAssets()
    return loadedAssets
end

function AssetLibrary:DestroyAsset(assetName)
    local asset = loadedAssets[assetName]
    if asset then
        asset:Destroy()
        loadedAssets[assetName] = nil
    else
        warn("Attempted to destroy non-existing asset: ", assetName)
    end
end

return AssetLibrary