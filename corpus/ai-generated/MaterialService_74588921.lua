-- MaterialService ModuleScript

local MaterialService = {}

-- Stores all material data
local materials = {}

-- Initializes the MaterialService with default data
function MaterialService:Initialize()
    self:AddMaterial("Obsidian", {
        Color = Color3.fromRGB(0, 0, 0),
        Transparency = 0.1,
        Reflectance = 0.9,
        Density = 2.6
    })

    -- Example of adding another material
    self:AddMaterial("Glass", {
        Color = Color3.fromRGB(200, 200, 255),
        Transparency = 0.5,
        Reflectance = 0,
        Density = 2.5
    })
end

-- Adds a new material to the service
-- name: string - The name of the material
-- properties: table - A table containing the material properties
function MaterialService:AddMaterial(name, properties)
    if materials[name] then
        warn("Material already exists: " .. name)
        return
    end
    materials[name] = properties
end

-- Retrieves properties of a specified material
-- name: string - The name of the material
-- returns: table - The properties of the material
function MaterialService:GetMaterialProperties(name)
    return materials[name] or error("Material not found: " .. name)
end

-- Modifies existing material properties
-- name: string - The name of the material
-- properties: table - A table with properties to update
function MaterialService:UpdateMaterialProperties(name, properties)
    local material = materials[name]
    if not material then
        error("Material not found: " .. name)
        return
    end

    for key, value in pairs(properties) do
        material[key] = value
    end
end

-- Removes a material from the service
-- name: string - The name of the material to remove
function MaterialService:RemoveMaterial(name)
    if not materials[name] then
        warn("Material not found: " .. name)
        return
    end
    materials[name] = nil
end

-- Retrieves all materials
-- returns: table - All materials and their properties
function MaterialService:GetAllMaterials()
    return materials
end

return MaterialService