#!/bin/bash

# =================================================================
# Code Aggregator Script - Collect project files into markdown
# =================================================================

# ==================== CONFIGURATION SECTION ====================
# Edit these variables to match your project needs

# Folders to include (space-separated, relative to script location)
# Use repo root by default to include everything relevant
FOLDERS_TO_INCLUDE=(
    ".."
)

# File extensions to include (without the dot)
FILE_EXTENSIONS=(
    "*"
    "dart"
    "js"
    "json"
    "yaml"
    "ts"
    "md"
    "txt"
    "sh"
    "py"
    "html"
    "css"
    "xml"
)

# Files to specifically include (even if extension not in list above)
SPECIFIC_FILES=(
    "../package.json"
    "../host.json"
    "../local.settings.json"
    "../openapi.yaml"
    "../README.md"
    "../test_query.json"
)

# Folders and files to exclude (regex patterns)
EXCLUDE_PATTERNS=(
    "node_modules"
    "\.git"
    "build"
    "\.dart_tool"
    "ios"
    "android"
    "macos" 
    "windows"
    "linux"
    "web"
    "(^|/)test(/|$)"
    "package-lock\.json"
    "pubspec\.lock"
    "\.DS_Store"
    "code-agg-.*\.md"
)

# Output file name (write to repo root)
OUTPUT_FILE="../$(date -u +'%d-%b-%Y')-code-agg-$(date -u +'%H%M').md"

# =================================================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if file should be excluded
should_exclude() {
    local file_path="$1"
    for pattern in "${EXCLUDE_PATTERNS[@]}"; do
        if [[ "$file_path" =~ $pattern ]]; then
            return 0  # Should exclude
        fi
    done
    return 1  # Should not exclude
}

# Function to check if file extension is included
is_extension_included() {
    local file="$1"
    local extension="${file##*.}"
    
    for ext in "${FILE_EXTENSIONS[@]}"; do
        if [[ "$ext" == "*" ]]; then
            return 0  # All extensions are included
        fi
        if [[ "$extension" == "$ext" ]]; then
            return 0  # Extension is included
        fi
    done
    return 1  # Extension not included
}

# Function to check if file is specifically included
is_specific_file() {
    local file="$1"
    local basename=$(basename "$file")
    
    for specific in "${SPECIFIC_FILES[@]}"; do
        if [[ "$basename" == "$specific" ]]; then
            return 0  # File is specifically included
        fi
    done
    return 1  # File not specifically included
}

# Function to get relative path
get_relative_path() {
    local file="$1"
    # Normalize to repo root
    local repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    echo "${file#$repo_root/}"
}

# Function to generate tree structure
generate_tree() {
    local temp_file=$(mktemp)
    local files_sorted=$(mktemp)

    # Collect all files that will be included (relative to repo root)
    for folder in "${FOLDERS_TO_INCLUDE[@]}"; do
        if [[ -d "$folder" ]]; then
            while IFS= read -r -d '' file; do
                if should_exclude "$file"; then
                    continue
                fi
                if is_extension_included "$file" || is_specific_file "$file"; then
                    local rel_path=$(get_relative_path "$file")
                    echo "$rel_path" >> "$temp_file"
                fi
            done < <(find "$folder" -type f -print0 2>/dev/null)
        fi
    done

    # Add specific root files (as relative paths)
    for specific_file in "${SPECIFIC_FILES[@]}"; do
        if [[ -f "$specific_file" ]] && ! should_exclude "$specific_file"; then
            local rel_path=$(get_relative_path "$specific_file")
            echo "$rel_path" >> "$temp_file"
        fi
    done

    # Deduplicate and sort files
    sort -u "$temp_file" > "$files_sorted"

    echo "Project Structure"
    echo "=================="

    if command -v tree >/dev/null 2>&1; then
        # Use tree command if available by creating temp dir structure
        local tree_temp=$(mktemp -d)
        # Create files with their directory structure
        while read -r file; do
            local file_dir="$tree_temp/$(dirname "$file")"
            mkdir -p "$file_dir"
            touch "$tree_temp/$file"
        done < "$files_sorted"
        tree "$tree_temp" -I '__pycache__|*.pyc|node_modules' --dirsfirst
        rm -rf "$tree_temp"
    else
        # Fallback: Use ls-style tree with proper indentation
        python3 -c "
import sys
from collections import defaultdict

files = []
with open('$files_sorted', 'r') as f:
    files = [line.strip() for line in f if line.strip()]

# Build directory tree structure
tree = defaultdict(list)
dirs = set()

for file in files:
    parts = file.split('/')
    for i in range(len(parts) - 1):
        parent = '/'.join(parts[:i+1]) if i > 0 else parts[0]
        dirs.add(parent)
        if i == len(parts) - 2:  # This is the parent dir of the file
            tree[parent].append(parts[-1])

# Print tree structure
def print_tree(path, indent=0):
    prefix = '  ' * indent + '├── '
    if path == '.':
        print('.')
        for item in sorted(dirs):
            if '/' not in item:
                print_tree(item, 1)
        # Print root files
        for file in files:
            if '/' not in file:
                print('  ├── ' + file)
    else:
        print(prefix + path.split('/')[-1] + '/')
        # Print subdirectories
        for d in sorted(dirs):
            if d.startswith(path + '/') and d.count('/') == path.count('/') + 1:
                print_tree(d, indent + 1)
        # Print files in this directory
        for file in sorted(tree[path]):
            print('  ' * (indent + 1) + '├── ' + file)

print_tree('.')
" 2>/dev/null || {
            # Ultimate fallback: simple list
            echo "."
            while read -r file; do
                depth=$(echo "$file" | tr -cd '/' | wc -c)
                indent=$(printf "%*s" $((depth * 2)) "")
                basename=$(basename "$file")
                echo "${indent}├── ${basename}"
            done < "$files_sorted"
        }
    fi

    rm -f "$temp_file" "$files_sorted"
}

# Main function to process files
process_files() {
    local total_files=0
    local processed_files=0
    local included_list=$(mktemp)
    
    print_status "Starting code aggregation..."
    
    # Create output file with header
    cat > "$OUTPUT_FILE" << EOF
# Project Code Export
Generated on: $(date)
Folders: ${FOLDERS_TO_INCLUDE[*]}
Extensions: ${FILE_EXTENSIONS[*]}
Specific files: ${SPECIFIC_FILES[*]}

EOF

    # Generate and add tree structure
    generate_tree >> "$OUTPUT_FILE"
    
    echo "" >> "$OUTPUT_FILE"

    # Process each specified folder
    for folder in "${FOLDERS_TO_INCLUDE[@]}"; do
        if [[ -d "$folder" ]]; then
            print_status "Processing folder: $folder"
            
            # Find all files in the folder
            while IFS= read -r -d '' file; do
                ((total_files++))
                
                if should_exclude "$file"; then
                    continue
                fi
                
                if is_extension_included "$file" || is_specific_file "$file"; then
                    local rel_path=$(get_relative_path "$file")
                    if ! grep -Fxq "$rel_path" "$included_list"; then
                        echo "$rel_path" >> "$included_list"
                        ((processed_files++))
                        print_status "Adding: $rel_path"
                        # Add file with simple format
                        echo "=== FILE: $rel_path ===" >> "$OUTPUT_FILE"
                        cat "$file" >> "$OUTPUT_FILE"
                        echo "" >> "$OUTPUT_FILE"
                        echo "" >> "$OUTPUT_FILE"
                    fi
                fi
            done < <(find "$folder" -type f -print0 2>/dev/null)
        else
            print_warning "Folder not found: $folder"
        fi
    done
    
    # Process specific files in root
    print_status "Processing specific root files..."
    for specific_file in "${SPECIFIC_FILES[@]}"; do
        if [[ -f "$specific_file" ]] && ! should_exclude "$specific_file"; then
            local rel_path=$(get_relative_path "$specific_file")
            if ! grep -Fxq "$rel_path" "$included_list"; then
                echo "$rel_path" >> "$included_list"
                ((processed_files++))
                print_status "Adding specific file: $rel_path"
                echo "=== FILE: $rel_path ===" >> "$OUTPUT_FILE"
                cat "$specific_file" >> "$OUTPUT_FILE"
                echo "" >> "$OUTPUT_FILE"
                echo "" >> "$OUTPUT_FILE"
            fi
        fi
    done
    
    # Add summary to end of file
    cat >> "$OUTPUT_FILE" << EOF

=== EXPORT SUMMARY ===
Total files found: $total_files
Files included: $processed_files
Export completed: $(date)
File size: $(du -h "$OUTPUT_FILE" 2>/dev/null | cut -f1 || echo "Unknown")
Generated by Code Aggregator Script
EOF

    print_success "Code aggregation complete!"
    print_success "Files processed: $processed_files/$total_files"
    print_success "Output saved to: $OUTPUT_FILE"
    
    # Show file size and cleanup
    local file_size=$(du -h "$OUTPUT_FILE" | cut -f1)
    print_status "Output file size: $file_size"
    rm -f "$included_list"
}

# Function to show help
show_help() {
    echo "Code Aggregator Script"
    echo "======================"
    echo ""
    echo "Usage: $0 [options]"
    echo ""
    echo "Options:"
    echo "  -h, --help     Show this help message"
    echo "  -c, --config   Show current configuration"
    echo "  -l, --list     List files that would be processed (dry run)"
    echo ""
    echo "Configuration is done by editing the variables at the top of this script."
}

# Function to show current configuration
show_config() {
    echo "Current Configuration:"
    echo "======================"
    echo "Folders to include: ${FOLDERS_TO_INCLUDE[*]}"
    echo "File extensions: ${FILE_EXTENSIONS[*]}"
    echo "Specific files: ${SPECIFIC_FILES[*]}"
    echo "Exclude patterns: ${EXCLUDE_PATTERNS[*]}"
    echo "Output file: $OUTPUT_FILE"
}

# Function to list files (dry run)
list_files() {
    echo "Files that would be processed:"
    echo "=============================="
    
    local count=0
    
    for folder in "${FOLDERS_TO_INCLUDE[@]}"; do
        if [[ -d "$folder" ]]; then
            echo "📁 $folder/"
            while IFS= read -r -d '' file; do
                if should_exclude "$file"; then
                    continue
                fi
                
                if is_extension_included "$file" || is_specific_file "$file"; then
                    ((count++))
                    local rel_path=$(get_relative_path "$file")
                    echo "  📄 $rel_path"
                fi
            done < <(find "$folder" -type f -print0 2>/dev/null)
        fi
    done
    
    echo ""
    echo "Specific root files:"
    for specific_file in "${SPECIFIC_FILES[@]}"; do
        if [[ -f "$specific_file" ]] && ! should_exclude "$specific_file"; then
            ((count++))
            echo "  📄 $specific_file"
        fi
    done
    
    echo ""
    echo "Total files: $count"
}

# Main script logic
case "${1:-}" in
    -h|--help)
        show_help
        ;;
    -c|--config)
        show_config
        ;;
    -l|--list)
        list_files
        ;;
    "")
        process_files
        ;;
    *)
        print_error "Unknown option: $1"
        echo "Use -h or --help for usage information."
        exit 1
        ;;
esac