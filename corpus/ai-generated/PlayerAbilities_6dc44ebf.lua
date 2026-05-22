local PlayerAbilities = {}

-- Required Services
local PlayerService = game:GetService("Players")
local UserInputService = game:GetService("UserInputService")
local Debris = game:GetService("Debris")

-- Configuration (Master Gold Palette)
local DASH_SPEED = 150
local DASH_COOLDOWN = 1.1
local COLOR_GOLD = Color3.fromRGB(255, 180, 0)
local COLOR_CYAN = Color3.fromRGB(0, 255, 255)
local DASH_SFX_ID = "rbxassetid://1347631165"

function PlayerAbilities:Initialize()
    local player = PlayerService.LocalPlayer
    
    player.CharacterAdded:Connect(function(char)
        local root = char:WaitForChild("HumanoidRootPart")
        
        -- VISIBILITY HOTFIX: Front/Back illumination
        for i = 1, 2 do
            local light = Instance.new("SurfaceLight")
            light.Color = COLOR_GOLD
            light.Brightness = 15
            light.Range = 10
            light.Face = (i == 1) and Enum.NormalId.Front or Enum.NormalId.Back
            light.Parent = root
        end
        
        -- Neon Aura
        for _, p in ipairs(char:GetChildren()) do
            if p:IsA("BasePart") then
                local highlight = Instance.new("SelectionBox")
                highlight.Adornee = p
                highlight.Color3 = COLOR_GOLD
                highlight.LineThickness = 0.05
                highlight.Transparency = 0.5
                highlight.Parent = p
            end
        end

        local canDash = true
        UserInputService.InputBegan:Connect(function(input, processed)
            if processed then return end
            if input.KeyCode == Enum.KeyCode.LeftShift or input.KeyCode == Enum.KeyCode.Q then
                if canDash then
                    canDash = false
                    local sfx = Instance.new("Sound", root)
                    sfx.SoundId = DASH_SFX_ID
                    sfx:Play()
                    Debris:AddItem(sfx, 1)

                    local dashVel = Instance.new("BodyVelocity")
                    dashVel.MaxForce = Vector3.new(1, 1, 1) * 1e6
                    dashVel.Velocity = root.CFrame.LookVector * DASH_SPEED
                    dashVel.Parent = root
                    
                    task.spawn(function()
                        for i = 1, 10 do
                            local ghost = Instance.new("Part")
                            ghost.Size = root.Size
                            ghost.CFrame = root.CFrame
                            ghost.Color = (i % 2 == 0) and COLOR_GOLD or COLOR_CYAN
                            ghost.Material = Enum.Material.Neon
                            ghost.Transparency = 0.7
                            ghost.Anchored = true
                            ghost.CanCollide = false
                            ghost.Parent = workspace
                            Debris:AddItem(ghost, 0.3)
                            task.wait(0.05)
                        end
                    end)
                    
                    task.wait(0.2)
                    dashVel:Destroy()
                    task.wait(DASH_COOLDOWN)
                    canDash = true
                end
            end
        end)
    end)
end

return PlayerAbilities