local StreetGenerator = {}

-- Required Services
local Workspace = game:GetService("Workspace")

-- Configuration
local COLOR_NEON_RED = Color3.fromRGB(255, 30, 30)

function StreetGenerator:BuildStreetGrid()
    print("🛣️ [STREETS] Rolling out Neon Grid...")
    
    local old = Workspace:FindFirstChild("CityGrid")
    if old then old:Destroy() end
    
    local root = Instance.new("Model")
    root.Name = "CityGrid"
    root.Parent = Workspace

    -- Massive Grid Lines
    local spacing = 80
    local size = 1000
    
    -- X Lines
    for i = -6, 6 do
        local line = Instance.new("Part")
        line.Size = Vector3.new(size, 0.5, 4)
        line.Position = Vector3.new(0, 0.2, i * spacing)
        line.Color = COLOR_NEON_RED
        line.Material = Enum.Material.Neon
        line.Transparency = 0.3
        line.Anchored = true
        line.CanCollide = false
        line.Parent = root
    end
    
    -- Z Lines
    for j = -6, 6 do
        local line = Instance.new("Part")
        line.Size = Vector3.new(4, 0.5, size)
        line.Position = Vector3.new(j * spacing, 0.2, 0)
        line.Color = COLOR_NEON_RED
        line.Material = Enum.Material.Neon
        line.Transparency = 0.3
        line.Anchored = true
        line.CanCollide = false
        line.Parent = root
    end
end

function StreetGenerator:Initialize()
    self:BuildStreetGrid()
end

return StreetGenerator