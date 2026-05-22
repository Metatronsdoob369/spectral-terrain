local StructureGenerator = {}
StructureGenerator.__index = StructureGenerator

local TEXTURES = {
    Obsidian = "rbxassetid://ObsidianTextureId",
    NeonRed = "rbxassetid://NeonRedTextureId"
}

local COLORS = {
    Obsidian = Color3.fromRGB(12, 12, 12),
    NeonRed = Color3.fromRGB(255, 0, 0)
}

local MATERIALS = {
    Obsidian = Enum.Material.SmoothPlastic,
    Neon = Enum.Material.Neon
}

function StructureGenerator.new()
    local self = setmetatable({}, StructureGenerator)
    self.structures = {}
    return self
end

function StructureGenerator:GenerateStreetGrid(position, size)
    local grid = Instance.new("Part")
    grid.Name = "NeonRedStreetGrid"
    grid.Size = size
    grid.Position = position
    grid.BrickColor = BrickColor.new(COLORS.NeonRed)
    grid.Material = MATERIALS.Neon
    grid.Anchored = true
    grid.CanCollide = false
    grid.Parent = workspace
    table.insert(self.structures, grid)
end

function StructureGenerator:GenerateSkyscraper(position, floors, baseSize)
    for i = 1, floors do
        local skyscraperPart = Instance.new("Part")
        skyscraperPart.Name = "ObsidianSkyscraperPart"
        skyscraperPart.Size = Vector3.new(baseSize.X, 12, baseSize.Z)
        skyscraperPart.Position = position + Vector3.new(0, (i - 1) * 12, 0)
        skyscraperPart.BrickColor = BrickColor.new(COLORS.Obsidian)
        skyscraperPart.Material = MATERIALS.Obsidian
        skyscraperPart.Anchored = true
        skyscraperPart.Parent = workspace
        table.insert(self.structures, skyscraperPart)
    end
end

function StructureGenerator:ClearStructures()
    for _, structure in ipairs(self.structures) do
        if structure and structure.Parent then
            structure:Destroy()
        end
    end
    self.structures = {}
end

return StructureGenerator