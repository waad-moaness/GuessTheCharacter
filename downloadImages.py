import json
import os
import re
import time
import unicodedata
import requests

# Load the categories file
with open("my-categories.json", "r", encoding="utf-8") as f:
  categories = json.load(f)

# Extract unique character names
unique_characters = set()
for category in categories:
  for item in category.get("items", []):
    unique_characters.add(item)


def format_filename(name):
  clean_name = re.sub(r"\s*\(.*?\)", "", name)
  clean_name = (
      unicodedata.normalize("NFKD", clean_name)
      .encode("ascii", "ignore")
      .decode("utf-8")
  )
  clean_name = clean_name.lower()
  clean_name = re.sub(r"[^\w\s-]", "", clean_name)
  clean_name = re.sub(r"[-\s]+", "-", clean_name).strip("-")
  return clean_name


# Create output folder
output_folder = "character_images"
os.makedirs(output_folder, exist_ok=True)

# Wikimedia requires a User-Agent header identifying your app
headers = {
    "User-Agent": "CharacterImageDownloader/1.0 (educational project)"
}

print(
    f"Starting download for {len(unique_characters)} characters via Wikimedia"
    " API..."
)

for character in unique_characters:
  base_name = format_filename(character)
  # Clean query for Wikipedia lookup
  search_title = re.sub(r"\s*\(.*?\)", "", character).strip()

  try:
    # Query Wikipedia REST API for page summary and thumbnail image
    api_url = (
        f"https://en.wikipedia.org/api/rest_v1/page/summary/{search_title}"
    )
    response = requests.get(api_url, headers=headers, timeout=10)

    image_url = None
    if response.status_code == 200:
      data = response.json()
      if "thumbnail" in data and "source" in data["thumbnail"]:
        image_url = data["thumbnail"]["source"]

    # Fallback: if summary API didn't return an image, try search query
    if not image_url:
      search_url = f"https://en.wikipedia.org/w/api.php?action=query&prop=pageimages&format=json&pithumbsize=500&titles={search_title}"
      search_resp = requests.get(search_url, headers=headers, timeout=10)
      if search_resp.status_code == 200:
        pages = search_resp.json().get("query", {}).get("pages", {})
        for page_id, page_info in pages.items():
          if "thumbnail" in page_info:
            image_url = page_info["thumbnail"]["source"]

    if image_url:
      img_response = requests.get(image_url, headers=headers, timeout=10)
      if img_response.status_code == 200:
        ext = image_url.split("?")[0].lower()
        if ext.endswith(".png"):
          filename = f"{base_name}.png"
        elif ext.endswith(".webp"):
          filename = f"{base_name}.webp"
        else:
          filename = f"{base_name}.jpg"

        filepath = os.path.join(output_folder, filename)
        with open(filepath, "wb") as handler:
          handler.write(img_response.content)
        print(f"[SUCCESS] Downloaded: {character} -> {filename}")
      else:
        print(f"[FAILED TO DOWNLOAD IMG] {character}")
    else:
      print(f"[NOT FOUND] No Wikipedia image for: {character}")

  except Exception as e:
    print(f"[ERROR] Error fetching {character}: {e}")

  # Pause 1 second between requests to be polite to Wikimedia servers
  time.sleep(1)

print(
    "Process complete! Check the folder:"
    f" {os.path.abspath(output_folder)}"
)