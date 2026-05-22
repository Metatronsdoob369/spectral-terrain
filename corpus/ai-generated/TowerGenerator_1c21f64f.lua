local TowerGenerator = {}

-- Required Services
local Workspace = game:GetService("Workspace")

-- Configuration (Harmonious Palette)
local COLOR_OBSIDIAN = Color3.fromRGB(15, 15, 15)
local COLOR_CYAN = Color3.fromRGB(0, 255, 255) -- Teal Harmony

local function buildArch(cframe, width, height, thickness)
    local segments = 8
    for i = 1, segments do
        local alpha = i / segments
        local angle = math.pi * alpha
        local segment = Instance.new("Part")
        segment.Size = Vector3.new(thickness, (width/segments) * 2, thickness)
        local x = (width/2) * math.cos(angle)
        local y = height + (width/2) * math.sin(angle) * 1.5
        segment.CFrame = cframe * CFrame.new(x, y, 0) * CFrame.Angles(0, 0, angle + math.pi/2)
        segment.Color = COLOR_OBSIDIAN
        segment.Material = Enum.Material.SmoothPlastic
        segment.Anchored = true
        segment.Parent = Workspace
    end
end

local function buildTower(position, width, height)
    local towerModel = Instance.new("Model")
    towerModel.Name = "ObsidianSkyscraper"
    towerModel.Parent = Workspace
    local core = Instance.new("Part")
    core.Size = Vector3.new(width, height, width)
    core.Position = position + Vector3.new(0, height/2, 0)
    core.Color = COLOR_OBSIDIAN
    core.Material = Enum.Material.SmoothPlastic
    core.Anchored = true
    core.Parent = towerModel
    
    -- Cyan Accents
    local head = Instance.new("Part")
    head.Size = Vector3.new(width + 2, 5, width + 2)
    head.Position = core.Position + Vector3.new(0, height/2 + 2.5, 0)
    head.Color = COLOR_CYAN
    head.Material = Enum.Material.Neon
    head.Anchored = true
    head.Parent = towerModel
end

function TowerGenerator:GenerateCity()
    print("💎 [CITY] Harmonizing Metropolis (Teal Core)...")
    local old = Workspace:FindFirstChild("Gothic_World")
    if old then old:Destroy() end
    local root = Instance.new("Model")
    root.Name = "Gothic_World"
    root.Parent = Workspace

    local spacing = 120
    for x = -3, 2 do
        for z = -3, 2 do
            if (math.abs(x) <= 1 and math.abs(z) <= 1) then continue end
            local pos = Vector3.new(x * spacing, 0, z * spacing)
            buildTower(pos, 40, 150 + math.random(50, 400))
        end
    end

    for i = -4, 4 do
        buildArch(CFrame.new(0, 0, i * 25), 50, 80, 5)
    end
end

function TowerGenerator:Initialize()
    self:GenerateCity()
end

return TowerGenerator