local MaterialService = {}

-- Table to store materials and their properties
local materials = {
    Obsidian = {
        Reflection = 0.7,
        Transparency = 0.1,
        Color = Color3.fromRGB(0, 0, 0)
    },
    NeonRed = {
        Reflection = 0.5,
        Transparency = 0,
        Color = Color3.fromRGB(255, 0, 0)
    },
    Concrete = {
        Reflection = 0.2,
        Transparency = 0,
        Color = Color3.fromRGB(150, 150, 150)
    }
}

-- Function to create a skyscraper with specific materials
function MaterialService:CreateSkyscraper(size, position, height)
    local skyscraper = Instance.new("Model")
    skyscraper.Name = "ObsidianSkyscraper"

    for i = 1, height do
        local block = Instance.new("Part")
        block.Size = Vector3.new(size.X, 10, size.Z)
        block.Position = position + Vector3.new(0, i * 10, 0)
        block.Material = Enum.Material.SmoothPlastic
        block.Color = materials.Obsidian.Color
        block.Reflectance = materials.Obsidian.Reflection
        block.Transparency = materials.Obsidian.Transparency
        block.Anchored = true
        block.Parent = skyscraper
    end

    skyscraper.Parent = workspace
    return skyscraper
end

-- Function to create a Neon Red street grid
function MaterialService:CreateNeonRedStreetGrid(gridSize, position)
    local streetGrid = Instance.new("Model")
    streetGrid.Name = "NeonRedStreetGrid"

    for x = 0, gridSize.X do
        for z = 0, gridSize.Z do
            local neonTile = Instance.new("Part")
            neonTile.Size = Vector3.new(2, 1, 2)
            neonTile.Position = position + Vector3.new(x * 2, 0, z * 2)
            neonTile.Material = Enum.Material.Neon
            neonTile.Color = materials.NeonRed.Color
            neonTile.Reflectance = materials.NeonRed.Reflection
            neonTile.Transparency = materials.NeonRed.Transparency
            neonTile.Anchored = true
            neonTile.Parent = streetGrid
        end
    end

    streetGrid.Parent = workspace
    return streetGrid
end

-- Function to create a concrete building block
function MaterialService:CreateConcreteBlock(size, position)
    local concreteBlock = Instance.new("Part")
    concreteBlock.Size = size
    concreteBlock.Position = position
    concreteBlock.Material = Enum.Material.Concrete
    concreteBlock.Color = materials.Concrete.Color
    concreteBlock.Reflectance = materials.Concrete.Reflection
    concreteBlock.Transparency = materials.Concrete.Transparency
    concreteBlock.Anchored = true
    concreteBlock.Parent = workspace
    return concreteBlock
end

return MaterialService