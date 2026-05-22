local StreetGenerator = {}

-- Required Services
local Workspace = game:GetService("Workspace")

-- Configuration (Harmonious Violet)
local COLOR_VIOLET = Color3.fromRGB(150, 0, 255)

function StreetGenerator:BuildStreetGrid()
    print("🌃 [STREETS] Shifting to Deep Violet Grid...")
    
    local old = Workspace:FindFirstChild("CityGrid")
    if old then old:Destroy() end
    
    local root = Instance.new("Model")
    root.Name = "CityGrid"
    root.Parent = Workspace

    local spacing = 80
    local size = 1200
    
    for i = -7, 7 do
        local lineX = Instance.new("Part")
        lineX.Size = Vector3.new(size, 0.5, 4)
        lineX.Position = Vector3.new(0, 0.2, i * spacing)
        lineX.Color = COLOR_VIOLET
        lineX.Material = Enum.Material.Neon
        lineX.Transparency = 0.4
        lineX.Anchored = true
        lineX.CanCollide = false
        lineX.Parent = root

        local lineZ = Instance.new("Part")
        lineZ.Size = Vector3.new(4, 0.5, size)
        lineZ.Position = Vector3.new(i * spacing, 0.2, 0)
        lineZ.Color = COLOR_VIOLET
        lineZ.Material = Enum.Material.Neon
        lineZ.Transparency = 0.4
        lineZ.Anchored = true
        lineZ.CanCollide = false
        lineZ.Parent = root
    end
end

function StreetGenerator:Initialize()
    self:BuildStreetGrid()
end

return StreetGenerator