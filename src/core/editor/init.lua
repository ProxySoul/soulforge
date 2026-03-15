-- SoulForge default neovim config
-- Only loaded when user has no ~/.config/nvim/init.{lua,vim}

local o = vim.o
local opt = vim.opt

-- ─── SoulForge data dir for plugins ───
local data_dir = vim.fn.stdpath("data") .. "/soulforge"
local plugins_dir = data_dir .. "/plugins"

-- ─── Leader key (must be set before plugins) ───
vim.g.mapleader = " "
vim.g.maplocalleader = " "

-- ─── Display (IDE-like defaults) ───
o.number = true
o.relativenumber = false
o.cursorline = true
o.signcolumn = "yes"
o.termguicolors = true
o.showmode = false
o.laststatus = 2
o.scrolloff = 8
o.sidescrolloff = 8
o.wrap = true
o.linebreak = true        -- wrap at word boundaries, not mid-word
o.breakindent = true       -- wrapped lines preserve indentation
opt.breakindentopt = { "shift:2" } -- indent wrapped continuation by 2
o.showbreak = "↪ "        -- visual indicator for wrapped lines
o.conceallevel = 0         -- show all text as-is (no hiding markup)
o.pumheight = 12           -- max completion popup height
o.cmdheight = 1
o.fillchars = "eob: "     -- hide ~ on empty lines

-- Make window separators visible in embedded mode
vim.api.nvim_set_hl(0, "WinSeparator", { fg = "#333333", bg = "NONE" })

-- ─── Indentation ───
o.tabstop = 2
o.shiftwidth = 2
o.expandtab = true
o.smartindent = true
o.autoindent = true
o.shiftround = true        -- round indent to multiple of shiftwidth

-- ─── Behavior ───
o.autoread = true
o.clipboard = "unnamedplus"
o.updatetime = 300
o.swapfile = false
o.undofile = true
o.mouse = "a"
o.splitright = true
o.splitbelow = true
o.confirm = true           -- ask to save instead of erroring
o.virtualedit = "block"    -- allow cursor past end in visual block
o.inccommand = "split"     -- live preview for :s substitutions
o.completeopt = "menuone,noselect,popup"
o.wildmode = "longest:full,full"
opt.shortmess:append("sI") -- reduce startup messages

-- ─── Search ───
o.ignorecase = true
o.smartcase = true
o.hlsearch = true
o.incsearch = true

-- ─── Auto-reload files changed on disk ───
vim.api.nvim_create_autocmd({ "FocusGained", "BufEnter", "CursorHold" }, {
  pattern = "*",
  command = "checktime",
})

-- ─── Diagnostic display ───
vim.diagnostic.config({
  virtual_text = { prefix = "●" },
  signs = true,
  underline = true,
  update_in_insert = false,
  severity_sort = true,
})

-- ─── Bootstrap plugin: clone if missing (async on first run) ───
local pending_clones = {}
local function ensure_plugin(name, url)
  local path = plugins_dir .. "/" .. name
  if not vim.uv.fs_stat(path) then
    table.insert(pending_clones, { name = name, url = url, path = path })
    return path
  end
  vim.opt.runtimepath:prepend(path)
  return path
end

-- Deferred clone: run all missing plugins after UI is ready
local function run_pending_clones()
  if #pending_clones == 0 then return end
  vim.fn.mkdir(plugins_dir, "p")
  local total = #pending_clones
  vim.notify("SoulForge: installing " .. total .. " plugins (first run)...", vim.log.levels.INFO)
  local completed = 0
  for _, p in ipairs(pending_clones) do
    vim.fn.jobstart({ "git", "clone", "--filter=blob:none", "--depth=1", p.url, p.path }, {
      on_exit = function(_, code)
        completed = completed + 1
        if code == 0 then
          vim.opt.runtimepath:prepend(p.path)
        end
        if completed == total then
          vim.notify("SoulForge: " .. total .. " plugins installed. Restart editor (Ctrl+E twice) for full experience.", vim.log.levels.INFO)
        end
      end,
    })
  end
  pending_clones = {}
end

-- ─── Catppuccin theme ───
pcall(function()
  ensure_plugin("catppuccin", "https://github.com/catppuccin/nvim")
  require("catppuccin").setup({
    flavour = "mocha",
    transparent_background = true,
    integrations = {
      alpha = true,
      gitsigns = true,
      indent_blankline = { enabled = true },
      mini = { enabled = true },
      telescope = { enabled = true },
      nvimtree = true,
      treesitter = true,
      mason = true,
      native_lsp = {
        enabled = true,
        underlines = {
          errors = { "undercurl" },
          hints = { "undercurl" },
          warnings = { "undercurl" },
          information = { "undercurl" },
        },
      },
    },
  })
  vim.cmd.colorscheme("catppuccin")
end)

-- ─── Dashboard (alpha-nvim) ───
pcall(function()
  ensure_plugin("alpha-nvim", "https://github.com/goolord/alpha-nvim")

  local alpha = require("alpha")
  local dashboard = require("alpha.themes.dashboard")

  dashboard.section.header.val = {
    "",
    "  ███████╗ ██████╗ ██╗   ██╗██╗     ███████╗ ██████╗ ██████╗  ██████╗ ███████╗",
    "  ██╔════╝██╔═══██╗██║   ██║██║     ██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝",
    "  ███████╗██║   ██║██║   ██║██║     █████╗  ██║   ██║██████╔╝██║  ███╗█████╗  ",
    "  ╚════██║██║   ██║██║   ██║██║     ██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝  ",
    "  ███████║╚██████╔╝╚██████╔╝███████╗██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗",
    "  ╚══════╝ ╚═════╝  ╚═════╝ ╚══════╝╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝",
    "",
    "                        ⚡ AI-Powered Terminal IDE",
    "",
  }
  dashboard.section.header.opts.hl = "AlphaHeader"

  dashboard.section.buttons.val = {
    dashboard.button("e",     "  New file",        "<cmd>ene<CR>"),
    dashboard.button("f",     "  Find file",       "<cmd>Telescope find_files<CR>"),
    dashboard.button("g",     "  Live grep",       "<cmd>Telescope live_grep<CR>"),
    dashboard.button("r",     "  Recent files",    "<cmd>Telescope oldfiles<CR>"),
    dashboard.button("SPC e", "  File explorer",   "<cmd>NvimTreeToggle<CR>"),
    dashboard.button("q",     "  Quit",            "<cmd>qa<CR>"),
  }

  dashboard.section.footer.val = "ProxySoul.com"
  dashboard.section.footer.opts.hl = "Comment"

  -- Highlight groups
  vim.api.nvim_set_hl(0, "AlphaHeader", { fg = "#cba6f7" }) -- mauve
  vim.api.nvim_set_hl(0, "AlphaButtons", { fg = "#89b4fa" }) -- blue
  vim.api.nvim_set_hl(0, "AlphaShortcut", { fg = "#f38ba8" }) -- red

  alpha.setup(dashboard.opts)

  -- Don't show statusline on dashboard
  vim.api.nvim_create_autocmd("FileType", {
    pattern = "alpha",
    callback = function()
      vim.opt_local.laststatus = 0
      vim.opt_local.showtabline = 0
    end,
  })
end)

-- ─── Tree-sitter ───
pcall(function()
  local ts_path = ensure_plugin("nvim-treesitter", "https://github.com/nvim-treesitter/nvim-treesitter")
  -- Add parsers install dir to runtimepath
  vim.opt.runtimepath:append(ts_path)

  require("nvim-treesitter.configs").setup({
    ensure_installed = {
      -- Web
      "typescript", "tsx", "javascript", "json", "json5", "jsonc",
      "html", "css", "scss", "graphql", "svelte", "vue",
      -- Systems
      "rust", "go", "c", "cpp", "zig",
      -- Scripting
      "lua", "python", "ruby", "bash",
      -- Config / Data
      "markdown", "markdown_inline", "yaml", "toml", "dockerfile",
      "sql", "prisma",
      -- Neovim
      "vim", "vimdoc", "regex", "query", "diff",
      -- Git
      "git_config", "gitcommit", "gitignore",
    },
    auto_install = true,
    highlight = {
      enable = true,
      additional_vim_regex_highlighting = false,
    },
    indent = { enable = true },
    incremental_selection = {
      enable = true,
      keymaps = {
        init_selection = "<C-space>",
        node_incremental = "<C-space>",
        scope_incremental = false,
        node_decremental = "<bs>",
      },
    },
  })
end)

-- ─── nvim-tree (file explorer) ───
pcall(function()
  ensure_plugin("nvim-web-devicons", "https://github.com/nvim-tree/nvim-web-devicons")
  ensure_plugin("nvim-tree.lua", "https://github.com/nvim-tree/nvim-tree.lua")

  require("nvim-web-devicons").setup()
  require("nvim-tree").setup({
    sync_root_with_cwd = true,
    respect_buf_cwd = true,
    update_focused_file = {
      enable = true,
      update_root = false,
    },
    view = {
      width = 28,
    },
    renderer = {
      icons = {
        show = {
          file = true,
          folder = true,
          folder_arrow = true,
          git = true,
        },
      },
    },
    actions = {
      open_file = {
        quit_on_open = false,
      },
    },
  })
end)

-- ─── gitsigns (git diff in gutter) ───
pcall(function()
  ensure_plugin("gitsigns.nvim", "https://github.com/lewis6991/gitsigns.nvim")
  require("gitsigns").setup({
    signs = {
      add          = { text = "▎" },
      change       = { text = "▎" },
      delete       = { text = "▁" },
      topdelete    = { text = "▔" },
      changedelete = { text = "▎" },
    },
    current_line_blame = false, -- toggle with <leader>gb
    on_attach = function(bufnr)
      local gs = package.loaded.gitsigns
      local function map(mode, l, r, desc)
        vim.keymap.set(mode, l, r, { buffer = bufnr, silent = true, desc = desc })
      end
      -- Navigation
      map("n", "]c", function() gs.nav_hunk("next") end, "Next hunk")
      map("n", "[c", function() gs.nav_hunk("prev") end, "Prev hunk")
      -- Actions
      map("n", "<leader>hs", gs.stage_hunk, "Stage hunk")
      map("n", "<leader>hr", gs.reset_hunk, "Reset hunk")
      map("n", "<leader>hp", gs.preview_hunk, "Preview hunk")
      map("n", "<leader>gb", gs.toggle_current_line_blame, "Toggle line blame")
      map("n", "<leader>hd", gs.diffthis, "Diff this")
    end,
  })
end)

-- ─── Telescope (fuzzy finder — VS Code Ctrl+P style) ───
pcall(function()
  ensure_plugin("plenary.nvim", "https://github.com/nvim-lua/plenary.nvim")
  ensure_plugin("telescope.nvim", "https://github.com/nvim-telescope/telescope.nvim")

  local telescope = require("telescope")
  local actions = require("telescope.actions")

  telescope.setup({
    defaults = {
      prompt_prefix = "   ",
      selection_caret = "  ",
      sorting_strategy = "ascending",
      layout_config = {
        horizontal = {
          prompt_position = "top",
          preview_width = 0.55,
        },
        width = 0.87,
        height = 0.80,
      },
      file_ignore_patterns = {
        "node_modules", ".git/", "dist/", "build/", "%.lock",
        "__pycache__", "%.pyc", "target/", "%.o", "%.a",
      },
      mappings = {
        i = {
          ["<C-j>"] = actions.move_selection_next,
          ["<C-k>"] = actions.move_selection_previous,
          ["<C-q>"] = actions.send_selected_to_qflist + actions.open_qflist,
          ["<Esc>"] = actions.close,
        },
      },
    },
    pickers = {
      find_files = {
        hidden = true,
        follow = true,
      },
      live_grep = {
        additional_args = function() return { "--hidden", "--glob", "!.git/" } end,
      },
    },
  })
end)

-- ─── mini.nvim (pairs, surround, comment, indentscope, statusline, cursorword) ───
pcall(function()
  ensure_plugin("mini.nvim", "https://github.com/echasnovski/mini.nvim")

  pcall(function() require("mini.pairs").setup() end)
  pcall(function() require("mini.surround").setup() end)
  pcall(function() require("mini.comment").setup() end)

  -- Animated indent scope line
  pcall(function()
    require("mini.indentscope").setup({
      symbol = "│",
      options = { try_as_border = true },
      draw = { animation = require("mini.indentscope").gen_animation.none() },
    })
    -- Disable on certain filetypes
    vim.api.nvim_create_autocmd("FileType", {
      pattern = { "help", "alpha", "NvimTree", "lazy", "mason" },
      callback = function() vim.b.miniindentscope_disable = true end,
    })
  end)

  -- Highlight word under cursor
  pcall(function()
    require("mini.cursorword").setup({ delay = 200 })
  end)

  -- Minimal statusline
  pcall(function()
    require("mini.statusline").setup({
      use_icons = true,
      set_vim_settings = false, -- we set laststatus ourselves
    })
  end)
end)

-- ─── which-key (keybinding discovery — press Space and see all options) ───
pcall(function()
  ensure_plugin("which-key.nvim", "https://github.com/folke/which-key.nvim")
  require("which-key").setup({
    delay = 300,
    icons = {
      breadcrumb = "»",
      separator = "→",
      group = "+ ",
    },
    spec = {
      { "<leader>f", group = "Find (Telescope)" },
      { "<leader>h", group = "Git hunks" },
      { "<leader>b", group = "Buffer" },
      { "<leader>c", group = "Code" },
      { "<leader>r", group = "Refactor" },
      { "<leader>g", group = "Git" },
    },
  })
end)

-- ─── Mason + LSP (v2 API — requires Neovim 0.11+) ───
pcall(function()
  ensure_plugin("mason.nvim", "https://github.com/mason-org/mason.nvim")
  ensure_plugin("mason-lspconfig.nvim", "https://github.com/mason-org/mason-lspconfig.nvim")
  ensure_plugin("nvim-lspconfig", "https://github.com/neovim/nvim-lspconfig")

  require("mason").setup()
  require("mason-lspconfig").setup({
    ensure_installed = {
      "ts_ls",
      "pyright",
      "ruff",
      "eslint",
      "biome",
      "lua_ls",
    },
    automatic_enable = true,
  })

  -- Per-server config via Neovim 0.11 native API
  vim.lsp.config("lua_ls", {
    settings = {
      Lua = {
        diagnostics = {
          globals = { "vim" },
        },
      },
    },
  })
end)

-- ─── Keybindings ───

-- VS Code muscle memory: Ctrl+S to save
vim.keymap.set({ "n", "i", "v" }, "<C-s>", "<cmd>write<CR><Esc>", { silent = true, desc = "Save file" })

-- Ctrl+Z undo in insert mode (VS Code style)
vim.keymap.set("i", "<C-z>", "<cmd>undo<CR>", { silent = true, desc = "Undo" })

-- jk to exit insert mode (beginner escape hatch)
vim.keymap.set("i", "jk", "<Esc>", { silent = true, desc = "Exit insert mode" })

-- File explorer: <leader>e toggles, - finds current file
vim.keymap.set("n", "<leader>e", "<cmd>NvimTreeToggle<CR>", { silent = true, desc = "Toggle file explorer" })
vim.keymap.set("n", "-", "<cmd>NvimTreeFindFile<CR>", { silent = true, desc = "Find current file in explorer" })

-- Telescope (VS Code-style keybindings)
vim.keymap.set("n", "<C-p>", "<cmd>Telescope find_files<CR>", { silent = true, desc = "Find files" })
vim.keymap.set("n", "<leader><leader>", "<cmd>Telescope find_files<CR>", { silent = true, desc = "Find files" })
vim.keymap.set("n", "<leader>ff", "<cmd>Telescope find_files<CR>", { silent = true, desc = "Find files" })
vim.keymap.set("n", "<leader>fg", "<cmd>Telescope live_grep<CR>", { silent = true, desc = "Live grep" })
vim.keymap.set("n", "<leader>fb", "<cmd>Telescope buffers<CR>", { silent = true, desc = "Buffers" })
vim.keymap.set("n", "<leader>fh", "<cmd>Telescope help_tags<CR>", { silent = true, desc = "Help tags" })
vim.keymap.set("n", "<leader>fr", "<cmd>Telescope oldfiles<CR>", { silent = true, desc = "Recent files" })
vim.keymap.set("n", "<leader>fd", "<cmd>Telescope diagnostics<CR>", { silent = true, desc = "Diagnostics" })
vim.keymap.set("n", "<leader>fs", "<cmd>Telescope lsp_document_symbols<CR>", { silent = true, desc = "Document symbols" })
vim.keymap.set("n", "<leader>fw", "<cmd>Telescope grep_string<CR>", { silent = true, desc = "Grep word under cursor" })

-- Better window navigation
vim.keymap.set("n", "<C-h>", "<C-w>h", { silent = true })
vim.keymap.set("n", "<C-j>", "<C-w>j", { silent = true })
vim.keymap.set("n", "<C-k>", "<C-w>k", { silent = true })
vim.keymap.set("n", "<C-l>", "<C-w>l", { silent = true })

-- Clear search highlights
vim.keymap.set("n", "<Esc>", "<cmd>nohlsearch<CR>", { silent = true })

-- Stay in visual mode when indenting
vim.keymap.set("v", "<", "<gv", { silent = true })
vim.keymap.set("v", ">", ">gv", { silent = true })

-- Move lines up/down in visual mode
vim.keymap.set("v", "J", ":m '>+1<CR>gv=gv", { silent = true })
vim.keymap.set("v", "K", ":m '<-2<CR>gv=gv", { silent = true })

-- Buffer navigation
vim.keymap.set("n", "<S-h>", "<cmd>bprevious<CR>", { silent = true, desc = "Previous buffer" })
vim.keymap.set("n", "<S-l>", "<cmd>bnext<CR>", { silent = true, desc = "Next buffer" })
vim.keymap.set("n", "<leader>bd", "<cmd>bdelete<CR>", { silent = true, desc = "Delete buffer" })

-- Quickfix navigation
vim.keymap.set("n", "<leader>q", "<cmd>copen<CR>", { silent = true, desc = "Open quickfix" })
vim.keymap.set("n", "]q", "<cmd>cnext<CR>", { silent = true, desc = "Next quickfix" })
vim.keymap.set("n", "[q", "<cmd>cprev<CR>", { silent = true, desc = "Prev quickfix" })

-- ─── LSP Keybindings ───
vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(ev)
    local bufopts = { buffer = ev.buf, silent = true }
    vim.keymap.set("n", "gd", vim.lsp.buf.definition, bufopts)
    vim.keymap.set("n", "gD", vim.lsp.buf.declaration, bufopts)
    vim.keymap.set("n", "gi", vim.lsp.buf.implementation, bufopts)
    vim.keymap.set("n", "gy", vim.lsp.buf.type_definition, bufopts)
    vim.keymap.set("n", "K", vim.lsp.buf.hover, bufopts)
    vim.keymap.set("n", "gr", "<cmd>Telescope lsp_references<CR>", bufopts)
    vim.keymap.set("n", "[d", vim.diagnostic.goto_prev, bufopts)
    vim.keymap.set("n", "]d", vim.diagnostic.goto_next, bufopts)
    vim.keymap.set("n", "<leader>rn", vim.lsp.buf.rename, bufopts)
    vim.keymap.set("n", "<leader>ca", vim.lsp.buf.code_action, bufopts)
    vim.keymap.set("n", "<leader>f", function() vim.lsp.buf.format({ async = true }) end, bufopts)
    vim.keymap.set("i", "<C-k>", vim.lsp.buf.signature_help, bufopts)
  end,
})

-- ─── Highlight on yank (visual feedback when copying) ───
vim.api.nvim_create_autocmd("TextYankPost", {
  callback = function()
    pcall(vim.highlight.on_yank, { higroup = "IncSearch", timeout = 200 })
  end,
})

-- ─── Restore cursor position when reopening files ───
vim.api.nvim_create_autocmd("BufReadPost", {
  callback = function()
    local mark = vim.api.nvim_buf_get_mark(0, '"')
    local lines = vim.api.nvim_buf_line_count(0)
    if mark[1] > 0 and mark[1] <= lines then
      pcall(vim.api.nvim_win_set_cursor, 0, mark)
    end
  end,
})

-- ─── Trim trailing whitespace on save ───
vim.api.nvim_create_autocmd("BufWritePre", {
  callback = function()
    local ft = vim.bo.filetype
    if ft == "diff" or ft == "mail" then return end -- skip for diffs/mail
    local pos = vim.api.nvim_win_get_cursor(0)
    vim.cmd([[silent! %s/\s\+$//e]])
    pcall(vim.api.nvim_win_set_cursor, 0, pos)
  end,
})

-- ─── Filetype detection (fallback) ───
vim.cmd("filetype plugin indent on")

-- ─── Async plugin bootstrap (first run) ───
vim.defer_fn(run_pending_clones, 100)
