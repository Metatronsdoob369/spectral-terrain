local StructureGenerator = {}

-- Required Services
local Workspace = game:GetService("Workspace")

-- Configuration
local BASE_POSITION = Vector3.new(0, 5, 0) -- Slightly above the baseplate
local SCALE = 2 -- Mastery Scale

-- Materials
local MAT_OBSIDIAN = Enum.Material.SmoothPlastic
local COLOR_OBSIDIAN = Color3.fromRGB(15, 15, 15)
local COLOR_NEON_RED = Color3.fromRGB(255, 30, 30)

-- Procedural Arch Generator
local function buildArch(cframe, width, height, thickness)
    local archModel = Instance.new("Model")
    archModel.Name = "GothicArch"
    archModel.Parent = Workspace

    -- Pillars
    local leftPillar = Instance.new("Part")
    leftPillar.Size = Vector3.new(thickness, height, thickness)
    leftPillar.CFrame = cframe * CFrame.new(-width/2, height/2, 0)
    leftPillar.Color = COLOR_OBSIDIAN
    leftPillar.Material = MAT_OBSIDIAN
    leftPillar.Anchored = true
    leftPillar.Parent = archModel

    local rightPillar = Instance.new("Part")
    rightPillar.Size = Vector3.new(thickness, height, thickness)
    rightPillar.CFrame = cframe * CFrame.new(width/2, height/2, 0)
    rightPillar.Color = COLOR_OBSIDIAN
    rightPillar.Material = MAT_OBSIDIAN
    rightPillar.Anchored = true
    rightPillar.Parent = archModel

    -- Pointed Arch Cap (Multiple Segments)
    local segments = 8
    for i = 1, segments do
        local alpha = i / segments
        local angle = math.pi * alpha
        
        local segment = Instance.new("Part")
        segment.Size = Vector3.new(thickness, (width/segments) * 2, thickness)
        
        -- Use math to create the pointed gothic curve
        local x = (width/2) * math.cos(angle)
        local y = height + (width/2) * math.sin(angle) * 1.5
        
        segment.CFrame = cframe * CFrame.new(x, y, 0) * CFrame.Angles(0, 0, angle + math.pi/2)
        segment.Color = COLOR_OBSIDIAN
        segment.Material = MAT_OBSIDIAN
        segment.Anchored = true
        segment.Parent = archModel
    end

    -- Neon Stained Glass
    local glass = Instance.new("Part")
    glass.Size = Vector3.new(width - thickness, height + (width/2), 0.5)
    glass.CFrame = cframe * CFrame.new(0, (height + width/2)/2, 0)
    glass.Color = COLOR_NEON_RED
    glass.Material = Enum.Material.Neon
    glass.Transparency = 0.5
    glass.CanCollide = false
    glass.Anchored = true
    glass.Parent = archModel
end

function StructureGenerator:GenerateCathedral()
    print("⛪ [ARCHITECTURE] Constructing Gothic Cyber-Cathedral...")
    
    -- Clear previous
    local old = Workspace:FindFirstChild("Cathedral")
    if old then old:Destroy() end
    
    local rootModel = Instance.new("Model")
    rootModel.Name = "Cathedral"
    rootModel.Parent = Workspace

    -- Build the Nave (Main Hall)
    for i = -4, 4 do
        local offset = i * 25
        buildArch(CFrame.new(0, 0, offset), 40, 60, 4)
    end

    -- Build the 2 Energy Steeples
    for _, zPos in ipairs({-110, 110}) do
        local steeple = Instance.new("Part")
        steeple.Size = Vector3.new(15, 200, 15)
        steeple.CFrame = CFrame.new(0, 100, zPos)
        steeple.Color = COLOR_OBSIDIAN
        steeple.Material = MAT_OBSIDIAN
        steeple.Anchored = true
        steeple.Parent = rootModel

        local core = Instance.new("Part")
        core.Size = Vector3.new(10, 220, 10)
        core.CFrame = CFrame.new(0, 110, zPos)
        core.Color = COLOR_NEON_RED
        core.Material = Enum.Material.Neon
        core.Anchored = true
        core.Parent = rootModel
        
        local pointLight = Instance.new("PointLight")
        pointLight.Color = COLOR_NEON_RED
        pointLight.Range = 200
        pointLight.Brightness = 10
        pointLight.Parent = core
    end
end

function StructureGenerator:Initialize()
    self:GenerateCathedral()
end

return StructureGenerator