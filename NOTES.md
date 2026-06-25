# Sifty Notes

## Bugs
- facebook query string does not get simplified (claude session exists: i want to investigate ho...)

## Refactoring
- change variable/method names to 'screaming architecture (worktree and claude session exists)

## Feature Ideas
- change discovery UX. location is compulsary. include sources to search (toggleable). for each have a dropdown: pickup only. shipping only. pickup or shipping.
- remove include/exclude keywords from filter. find a way to add them to the url generation before quickScrape
- create a new parent container called search parameters. it includes the urls and the filters all prepopulated from the discovery card. should also include location etc. Can all be edited and saved as a future search.
- move 'apply ai filter' (rename to filter with AI) next to deepSearch button (and copy cancelation functionality)
- add deep search hires images?
- add source to results
- add combining of pickup and location data in results (ie. if you choose pickup, filter on location of pickup)
- do not allow shipping from facebook (or define pickup and shipping at a 'scraping source' level)

## Exploratory
- ai filtering of images
- integrating with Browser Use
- explore playwright anti fingerprinting patches 
- improved workflow. what do you want. why? what do you need it for. here's a listing im looking at. how does it compare?

## Tooling
- find a way to diff and comment after claude has made changes (pre commit)



## Test Cases
### Laptop
- Macbook pro m1 or m2 with 16gb of ram. Not an i5 or i7. Year 2020 or newer.
- i7, i5, 2019, 2018, 2017, 2016, 2015, 2014, 2013, 2012, 2011, 2010, A2338, A2289, A1708
- https://www.trademe.co.nz/a/marketplace/computers/laptops/laptops/apple/search?search_string=macbook%20pro&condition=used&RefinePanel5c34c1efa0ac468f91e15161d549c479=16%20to%2031%20gb&RefinePanel7a2bb94c0cb44806ac995a4fc854bcbc=13%22&RefinePanel7a2bb94c0cb44806ac995a4fc854bcbc=14%22&RefinePanel7a2bb94c0cb44806ac995a4fc854bcbc=15%22
- https://www.trademe.co.nz/a/marketplace/computers/laptops/laptops/apple/search
- https://www.facebook.com/marketplace/114912541853133/search/?query=macbook%20pro&exact=false

### Dining table and chairs

### Mercedes
- mercedes benz station wagon between 1990 and 1995
- https://www.trademe.co.nz/a/motors/cars/mercedes-benz/search?vehicle_condition=used&year_min=1990&year_max=1996

### Bookshelves
- https://www.trademe.co.nz/a/marketplace/home-living/lounge-dining-hall/cabinets-bookshelves/bookshelves/search?search_string=bookshelf
- https://www.trademe.co.nz/a/home-living/lounge-dining-hall/cabinets-bookshelves/bookshelves/search
